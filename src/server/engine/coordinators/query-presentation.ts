import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { FEISHU_MESSAGE_LIMIT } from '../../channels/limits.js';
import { FEISHU_SNAPSHOT_REFRESH_MS } from '../../../shared/feishu-card-config.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { t } from '../../../shared/i18n/index.js';
import { MessageRenderer } from '../messages/renderer.js';
import { PlanBoard } from '../plan-board.js';
import { QueryExecutionPresenter } from '../../presentation/query-presenter.js';
import { SubagentFlowPresenter } from '../../presentation/subagent-presenter.js';

export interface QueryTypingHandle {
  stop(): void;
}

interface QueryPresentationFactoryOptions {
  defaultWorkdir: string;
  typingIntervalMs?: number;
}

interface QueryTurnPresentationOptions {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: { cwd?: string; sessionId?: string; sdkSessionId?: string };
  sessionKey: string;
  reactions: { permission: string; processing: string; stalled: string };
  typing: QueryTypingHandle;
  onMessageId: (messageId: string) => void;
}

export interface QueryTurnPresentation {
  renderer: MessageRenderer;
  presenter: QueryExecutionPresenter;
  subagents?: SubagentFlowPresenter;
}

/** Owns per-turn IM presentation wiring: typing, renderer, presenter, reactions. */
export class QueryPresentationFactory {
  private readonly typingIntervalMs: number;
  private readonly plans = new PlanBoard();

  constructor(private readonly options: QueryPresentationFactoryOptions) {
    this.typingIntervalMs = options.typingIntervalMs ?? 4000;
  }

  startTyping(adapter: BaseChannelAdapter, msg: InboundMessage): QueryTypingHandle {
    return new QueryTypingIndicator(adapter, msg.chatId, this.typingIntervalMs).start();
  }

  createTurn(options: QueryTurnPresentationOptions): QueryTurnPresentation {
    const { adapter, msg, binding, sessionKey, reactions, typing, onMessageId } = options;
    let stalledReactionAdded = false;
    let renderer!: MessageRenderer;
    const getProgressMessageId = (): string | undefined => renderer?.messageId;

    const presenter = new QueryExecutionPresenter({
      adapter,
      inbound: msg,
      clearTyping: () => typing.stop(),
      getMessageId: getProgressMessageId,
      sessionKey,
      onMessageId,
    });

    // Feishu is the only channel today (ChannelType is a single literal), so the cadence below is
    // not a branch: Feishu types each push's appended tail on its own clock, which makes one page
    // refresh per second enough for the animation; a faster cadence would only multiply entity ops.
    const refreshMs = FEISHU_SNAPSHOT_REFRESH_MS;
    // Bind board ownership to trusted routing AND a session generation (/new rotates it).
    const planSession = binding.sessionId ?? binding.sdkSessionId;
    const planScope = planSession ? JSON.stringify([
      adapter.channelType, msg.chatId, msg.userId, msg.threadId ?? '', msg.scopeId ?? '',
      sessionKey, planSession,
    ]) : undefined;
    renderer = new MessageRenderer({
      // FeishuSender owns the combined byte/table split and its message-id topology.
      // Supplying a predicate disables MessageRenderer's generic size-estimation fallback.
      shouldSplitState: () => false,
      channelOwnsPagination: true,
      platformLimit: FEISHU_MESSAGE_LIMIT,
      throttleMs: refreshMs,
      adaptiveFlush: {
        // A pinned band (base = min = max) is deliberate: it switches off the size/output-speed/
        // latency penalties, because the card edits at its own pace anyway. Only the rate-limit
        // ladder is allowed to stretch this.
        baseMs: refreshMs,
        minMs: refreshMs,
        maxMs: refreshMs,
        anchorToLastFlush: true,
        rateLimitBackoffMs: 2000,
      },
      cwd: binding.cwd || this.options.defaultWorkdir,
      sessionId: binding.sdkSessionId,
      // A renderer only lives for one turn; the board is what makes the plan survive to the next.
      initialTodos: this.plans.current(planScope),
      onTodosChanged: (items) => {
        this.plans.update(planScope, items);
      },
      onPermissionReaction: () => {
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.permission).catch(() => {});
        }
      },
      onPermissionReactionClear: () => {
        if (renderer.messageId) {
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.processing).catch(() => {});
        }
      },
      onProgressStalled: () => {
        if (renderer.messageId && !stalledReactionAdded) {
          stalledReactionAdded = true;
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.stalled).catch(() => {});
        }
      },
      onProgressResumed: () => {
        if (renderer.messageId && stalledReactionAdded) {
          stalledReactionAdded = false;
          adapter.addReaction(msg.chatId, renderer.messageId, reactions.processing).catch(() => {});
        }
      },
      onFlushError: (error, context) => {
        const _locale = adapter.getLocale();
        const phaseText =
          context.phase === 'completed'
            ? t('progress.phaseCompleted')
            : context.phase === 'failed'
              ? t('progress.phaseFailed')
              : t('progress.phaseRunning');
        const notifyMsg = adapter.format({
          type: 'error',
          chatId: msg.chatId,
          data: {
            title: `${t('format.flushErrorTitle')} (${phaseText})`,
            message: `${(error.message || String(error)).slice(0, 150)}\n\n${t('format.flushErrorHint')}`,
          },
        });
        adapter.send(withInboundReplyContext(notifyMsg, msg)).catch(() => {});
      },
      flushCallback: (content, isEdit, buttons, state) =>
        presenter.flush(content, isEdit, buttons, state),
    });

    const subagents = adapter.channelType === 'feishu' ? new SubagentFlowPresenter({
      adapter, inbound: msg, parentTurnId: renderer.presentationTurnId,
      cwd: binding.cwd || this.options.defaultWorkdir,
      onError: () => console.warn('[subagent-flow] Child card update failed; original child/model execution is unchanged'),
    }) : undefined;
    return { renderer, presenter, subagents };
  }
}

class QueryTypingIndicator implements QueryTypingHandle {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly adapter: BaseChannelAdapter,
    private readonly chatId: string,
    private readonly intervalMs: number,
  ) {}

  start(): this {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
    return this;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.adapter.sendTyping(this.chatId).catch(() => {});
  }
}
