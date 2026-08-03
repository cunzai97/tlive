import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../channels/types.js';
import type { TaskSummaryData } from '../../shared/formatting/message-types.js';
import { chunkByParagraphBytes } from '../../shared/formatting/text-chunk.js';
import type { MessageRendererState } from '../engine/messages/renderer.js';
import type { TimelineEntry } from '../engine/messages/renderer-types.js';
import { truncate } from '../../shared/core/string.js';
import { buildProgressData } from '../engine/messages/progress-builder.js';
import type { Button } from '../../shared/ui/types.js';
import { t } from '../../shared/i18n/index.js';
import { withInboundReplyContext } from '../channels/reply-context.js';
import {
  conversationSurface,
  progressButtonsForSurface,
  taskSummaryButtonsForSurface,
} from '../engine/conversations/surface-policy.js';

/** Pass buttons through unchanged */
function castButtons(buttons?: Button[]): Button[] | undefined {
  return buttons;
}

interface QueryExecutionPresenterOptions {
  adapter: BaseChannelAdapter;
  inbound: InboundMessage;
  platformLimit: number;
  clearTyping: () => void;
  getMessageId: () => string | undefined;
  sessionKey?: string;
  onMessageId?: (messageId: string) => void;
}

export class QueryExecutionPresenter {
  private adapter: BaseChannelAdapter;
  private inbound: InboundMessage;
  private platformLimit: number;
  private clearTyping: () => void;
  private getMessageId: () => string | undefined;
  private sessionKey?: string;
  private onMessageId?: (messageId: string) => void;
  private surface: ReturnType<typeof conversationSurface>;

  constructor(options: QueryExecutionPresenterOptions) {
    this.adapter = options.adapter;
    this.inbound = options.inbound;
    this.platformLimit = options.platformLimit;
    this.clearTyping = options.clearTyping;
    this.getMessageId = options.getMessageId;
    this.sessionKey = options.sessionKey;
    this.onMessageId = options.onMessageId;
    this.surface = conversationSurface({
      threadId: this.inbound.threadId,
      scopeId: this.inbound.scopeId,
    });
  }

  async flush(
    content: string,
    isEdit: boolean,
    buttons?: Button[],
    state?: MessageRendererState,
  ): Promise<string | undefined> {
    if (state && !this.adapter.shouldRenderProgressPhase(state.phase)) {
      return;
    }

    let outMsg: RenderedMessage;
    if (state) {
      const _locale = this.adapter.getLocale();
      const actionButtons = buttons ?? this.defaultProgressActionButtons(state);
      const progressData = buildProgressData(
        state,
        this.inbound.text || t('format.continueTask'),
        castButtons(actionButtons),
        content,
      );

      if (state.phase === 'completed' && this.shouldSplitCompletedTrace(state)) {
        const traceMsg = this.adapter.format({
          type: 'progress',
          chatId: this.inbound.chatId,
          data: {
            ...progressData,
            renderedText: '',
            footerLine: undefined,
            completedTraceOnly: true,
          },
        });
        const traceOutMsg = withInboundReplyContext(traceMsg, this.inbound);
        if (isEdit) {
          await this.editExistingOrSend(traceOutMsg);
        } else {
          const traceResult = await this.adapter.send(traceOutMsg);
          this.clearTyping();
          void traceResult;
        }

        const summaryMsg = this.adapter.format({
          type: 'taskSummary',
          chatId: this.inbound.chatId,
          data: this.buildTaskSummary(state),
        });
        await this.adapter.send(withInboundReplyContext(summaryMsg, this.inbound));
        return;
      }

      outMsg = this.adapter.format({
        type: 'progress',
        chatId: this.inbound.chatId,
        data: progressData,
      });
    } else {
      outMsg = this.adapter.formatContent(this.inbound.chatId, content, castButtons(buttons));
    }
    outMsg = withInboundReplyContext(outMsg, this.inbound);

    if (!isEdit) {
      const result = await this.adapter.send(outMsg);
      this.clearTyping();
      if (result.messageId) this.onMessageId?.(result.messageId);
      return result.messageId;
    }

    // 分块检查：渲染后的文本过大时降级为纯文本分块发送。
    // 注意：shouldSplitBubble 已通过 shouldSplitState 精确检查实际卡片大小，
    // 这里的检查是最后的兜底安全网，阈值与纯文本保持一致即可。
    const isProgressCard = !!state;
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const effectiveLimitBytes = this.platformLimit;

    if (contentBytes > effectiveLimitBytes) {
      const chunkByteSize = this.platformLimit;
      const chunks = chunkByParagraphBytes(content, chunkByteSize);
      const firstMessage = withInboundReplyContext(
        this.adapter.formatContent(this.inbound.chatId, chunks[0]),
        this.inbound,
      );
      const fallbackMessageId = await this.editExistingOrSend(firstMessage);
      for (let i = 1; i < chunks.length; i++) {
        await this.adapter.send(
          withInboundReplyContext(
            this.adapter.formatContent(this.inbound.chatId, chunks[i]),
            this.inbound,
          ),
        );
      }
      return fallbackMessageId;
    }

    try {
      return await this.editExistingOrSend(outMsg);
    } catch (err: any) {
      // 编辑/发送失败，尝试分块重试
      const retryChunkSize = this.platformLimit;
      if (contentBytes > retryChunkSize) {
        console.warn(
          `[presenter] flush failed (${isProgressCard ? 'progress' : 'plain'} card), retrying with chunked content (${contentBytes} bytes)`,
        );
        const chunks = chunkByParagraphBytes(content, retryChunkSize);
        const firstMessage = withInboundReplyContext(
          this.adapter.formatContent(this.inbound.chatId, chunks[0]),
          this.inbound,
        );
        const fallbackMessageId = await this.adapter.send(firstMessage);
        this.clearTyping();
        if (fallbackMessageId.messageId) this.onMessageId?.(fallbackMessageId.messageId);
        for (let i = 1; i < chunks.length; i++) {
          await this.adapter.send(
            withInboundReplyContext(
              this.adapter.formatContent(this.inbound.chatId, chunks[i]),
              this.inbound,
            ),
          );
        }
        return fallbackMessageId.messageId;
      }
      throw err;
    }
  }

  async dispose(): Promise<void> {}

  private defaultProgressActionButtons(state: MessageRendererState): Button[] | undefined {
    return progressButtonsForSurface(
      this.surface,
      state.phase,
      this.adapter.getLocale(),
      this.sessionKey,
    );
  }

  private buildTaskSummary(state: {
    responseText: string;
    renderedText: string;
    toolLogs: Array<{ name: string; input: string }>;
    timeline?: TimelineEntry[];
    toolUseSummaryText?: string;
    permissionRequests: number;
    errorMessage?: string;
    footerLine?: string;
  }): TaskSummaryData {
    // Allow full summary for task completion (up to 5000 chars)
    const locale = this.adapter.getLocale();
    const summarySource = this.finalSummarySource(state);
    const summary = truncate(summarySource || t('format.taskCompleted'), 5000);
    const changedFileKeys = new Set(
      state.toolLogs
        .filter((log) => ['Edit', 'Write', 'MultiEdit'].includes(log.name) && log.input.trim())
        .map((log) => log.input.trim()),
    );
    const hasError = !!state.errorMessage;

    return {
      summary,
      changedFiles: changedFileKeys.size,
      permissionRequests: state.permissionRequests,
      hasError,
      footerLine: state.footerLine,
      actionButtons: taskSummaryButtonsForSurface(this.surface, locale),
    };
  }

  private async editExistingOrSend(message: RenderedMessage): Promise<string | undefined> {
    try {
      await this.adapter.editMessage(this.inbound.chatId, this.getMessageId()!, message);
      return;
    } catch (err: any) {
      if (err?.retryable) throw err;
      // 编辑失败，尝试发送新消息
      try {
        const result = await this.adapter.send(message);
        this.clearTyping();
        if (result.messageId) this.onMessageId?.(result.messageId);
        return result.messageId;
      } catch (sendErr: any) {
        // 发送也失败（可能是内容过大），记录警告但不抛出错误
        // 上层 flush() 会处理分块重试
        console.warn(
          `[presenter] editExistingOrSend: both edit and send failed, content may be too large. ${sendErr?.message ?? sendErr}`,
        );
        throw sendErr;
      }
    }
  }

  private finalSummarySource(state: {
    responseText: string;
    timeline?: TimelineEntry[];
    toolUseSummaryText?: string;
  }): string {
    const timeline = state.timeline ?? [];
    const hasProcessEntries = timeline.some((entry) => entry.kind !== 'text');
    if (!hasProcessEntries) return (state.responseText || '').trim();
    if (!timeline.some((entry) => entry.kind === 'text' && entry.text?.trim())) {
      return (state.responseText || '').trim();
    }

    const trailingText: string[] = [];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const entry = timeline[i];
      if (entry.kind === 'text') {
        const text = (entry.text || '').trim();
        if (text) trailingText.unshift(text);
        continue;
      }
      if (trailingText.length > 0) break;
    }

    const finalText = trailingText.join('\n\n').trim();
    if (finalText) return finalText;
    return (state.toolUseSummaryText || '').trim();
  }

  private shouldSplitCompletedTrace(state: {
    thinkingText: string;
    timeline: Array<{ kind: 'thinking' | 'text' | 'tool' }>;
    responseText: string;
  }): boolean {
    let thinkingCount = 0;
    let toolCount = 0;
    for (const entry of state.timeline) {
      if (entry.kind === 'thinking') thinkingCount++;
      else if (entry.kind === 'tool') toolCount++;
    }
    return this.adapter.shouldSplitCompletedTrace({
      thinkingTextLength: state.thinkingText.trim().length,
      timelineLength: state.timeline.length,
      thinkingEntries: thinkingCount,
      toolEntries: toolCount,
      responseTextLength: state.responseText.trim().length,
    });
  }
}
