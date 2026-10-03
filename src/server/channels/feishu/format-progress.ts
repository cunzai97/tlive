/** Lossless block-format progress cards; phase-summary formatting remains opt-in legacy. */
import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { ProgressData } from '../../../shared/formatting/message-types.js';
import type { StepUsage } from '../../../shared/canonical/schema.js';
import { truncate } from '../../../shared/core/string.js';
import { shortPath } from '../../../shared/core/path.js';
import { TODO_MARKERS } from '../../../shared/canonical/plan-signature.js';
import type { FeishuCardElement } from './card-builder.js';
import type { SubagentCardChunk } from './subagent-budget.js';
import { buttonElements, codeBlockElement, collapsiblePanel, markdownElement } from './card-elements.js';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';
import { FEISHU_THINKING_PREVIEW_TOKENS, thinkingTail, type ThinkingPreview } from './thinking-preview.js';
import {
  buildProgressTimelineElements as buildLegacyTimelineElements,
  buildProgressContentElements as buildLegacyContentElements,
} from './format-progress-legacy.js';
import {
  buildFlowBlocks,
  collectFlowItems,
  isFlowTerminal,
  type FlowOptions,
  type FlowTextBlock,
  type FlowToolBlock,
  type FlowBlock,
} from './flow-blocks.js';
import {
  createDefaultToolDisplayRegistry,
  flowElementId,
  flowStatusLabel,
} from './tool-display.js';

export { progressHeaderConfig } from './format-progress-legacy.js';
export type { FlowOptions } from './flow-blocks.js';

export interface FormatProgressParams {
  chatId: string;
  data: ProgressData;
  md: (content: string) => FeishuCardElement;
  locale: Locale;
  flowOptions?: FlowOptions;
  /** Register the full semantic block before removing history from the serialized card. */
  registerThinkingDetails?: (block: FlowTextBlock) => string | undefined;
  subagentChunks?: SubagentCardChunk[];
}

/** The exact semantic text IDs used by the block renderer, including nested thoughts. */
export function progressStreamingElementIds(
  data: ProgressData,
  options: FlowOptions = {},
): string[] {
  // Identity does not depend on grouping. Do not invoke an exact tokenizer twice per flush.
  const items = collectFlowItems(data, options.registry ?? createDefaultToolDisplayRegistry());
  if (isFlowTerminal(data) && data.completedTraceOnly) {
    while (items[items.length - 1]?.kind === 'text') items.pop();
  }
  return items
    .filter((item) => item.kind !== 'tool' && item.text.trim())
    .map((item) => flowElementId('text', item.id ?? item.kind));
}

interface ThinkingView extends ThinkingPreview {
  detailId: string;
}

/** One 300-token estimate for all thought previews, newest first, not 300 per historic block. */
function thinkingViews(blocks: FlowBlock[], params: FormatProgressParams): Map<FlowTextBlock, ThinkingView> {
  const thoughts = blocks.flatMap(block => block.kind === 'tool_group'
    ? block.children.filter((child): child is FlowTextBlock => child.kind === 'thinking')
    : block.kind === 'thinking' ? [block] : []);
  const detailIds = new Map<FlowTextBlock, string>();
  for (const block of thoughts) {
    const id = params.registerThinkingDetails?.(block);
    if (id) detailIds.set(block, id);
  }
  const views = new Map<FlowTextBlock, ThinkingView>();
  let remaining = FEISHU_THINKING_PREVIEW_TOKENS;
  for (let index = thoughts.length - 1; index >= 0; index--) {
    const block = thoughts[index];
    const detailId = detailIds.get(block);
    // Never silently discard content when full-detail retention is unavailable.
    if (!detailId) continue;
    // Redact BEFORE slicing: a tail cut through a credential must not defeat redaction.
    const preview = thinkingTail(redactSensitiveContent(block.text), remaining);
    remaining -= preview.tokens;
    views.set(block, { ...preview, detailId });
  }
  return views;
}

function textElements(
  block: FlowTextBlock,
  params: FormatProgressParams,
  views: Map<FlowTextBlock, ThinkingView>,
): FeishuCardElement[] {
  if (!block.text.trim()) return [];
  const identity = block.id ?? block.kind;
  const view = views.get(block);
  const children: FeishuCardElement[] = [];
  if (!view || view.text) {
    const body = view?.text ?? block.text;
    // Reasoning is verbatim model output: fence it so Feishu renders a code block rather than
    // reparsing markdown, headings and stray backticks inside the thought.
    const element = block.kind === 'thinking' ? codeBlockElement(body) : params.md(body);
    children.push({ ...element, element_id: flowElementId('text', identity) });
  }
  if (block.kind === 'text') {
    params.subagentChunks?.push({ kind: 'text', elementIds: children.map(node => node.element_id as string) });
    return children;
  }
  if (!view && params.registerThinkingDetails) {
    children.push(params.md(params.locale === 'zh'
      ? '完整思考详情暂不可用；为避免丢失内容，此处保留全文。'
      : 'Full thinking details are unavailable; retaining the complete text here.'));
  }
  if (view?.omitted) {
    children.push(params.md(params.locale === 'zh'
      ? view.text ? '仅显示最近约 300 Token；较早内容请查看完整思考。' : '较早思考已移至详情，不占主卡正文空间。'
      : view.text ? 'Latest ~300 estimated tokens only; earlier thoughts are in details.' : 'Earlier thoughts are available in details.'));
  }
  if (view) {
    children.push(...buttonElements([{
      label: params.locale === 'zh' ? '查看完整思考' : 'View full thinking',
      callbackData: `flow_detail:open:${view.detailId}`,
    }]));
  }
  params.subagentChunks?.push({ kind: 'thinking', elementIds: [flowElementId('thinking', identity)] });
  return [{
    ...collapsiblePanel(
      `${flowStatusLabel(block.status, params.locale)} · ${t('progress.labelThinkingProcess', params.locale)}`,
      children,
      { expanded: block.status === 'running' },
    ),
    element_id: flowElementId('thinking', identity),
  }];
}

/** One group row, one line: 3.2k reads narrower than 3,200 and 64k than 64.0k. */
function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return `${Number(thousands.toFixed(thousands < 100 ? 1 : 0))}k`;
}

/**
 * Cost of the round-trips behind a group. Parallel calls share one round-trip, so each step counts
 * once; context is cumulative rather than additive, so the newest step wins over the sum.
 */
function stepUsageSuffix(tools: readonly FlowToolBlock[]): string {
  const steps = new Map<number, StepUsage>();
  for (const tool of tools) if (tool.usage) steps.set(tool.usage.step, tool.usage);
  if (!steps.size) return '';
  let input = 0;
  let output = 0;
  let context = 0;
  let window = 0;
  for (const usage of steps.values()) {
    input += usage.inputTokens;
    output += usage.outputTokens;
    context = Math.max(context, usage.contextTokens);
    window = usage.contextWindow ?? window;
  }
  // A rounding-to-zero group still used context; 0% would read as "nothing loaded".
  const percent = window > 0 ? ` ${Math.max(1, Math.round((context / window) * 100))}%` : '';
  return ` ↓${tokenCount(input)} ↑${tokenCount(output)} ${tokenCount(context)}${percent}`;
}

export function buildProgressTimelineElements(params: FormatProgressParams): FeishuCardElement[] {
  if (params.flowOptions?.mode === 'legacy') return buildLegacyTimelineElements(params);
  const registry = params.flowOptions?.registry ?? createDefaultToolDisplayRegistry();
  const blocks = buildFlowBlocks(params.data, { ...params.flowOptions, registry });
  const views = thinkingViews(blocks, params);
  const elements: FeishuCardElement[] = [];
  for (const block of blocks) {
    if (block.kind !== 'tool_group') {
      elements.push(...textElements(block, params, views));
      continue;
    }
    const children: FeishuCardElement[] = [];
    const failures: Array<{ id: string; text: string }> = [];
    const tools = block.children.filter((child) => child.kind === 'tool');
    for (const child of block.children) {
      if (child.kind === 'tool') {
        const display = registry.display(child, params.locale);
        children.push(...display.elements);
        params.subagentChunks?.push({ kind: 'tool', elementIds: display.elements.map(node => node.element_id as string), toolName: child.toolName, status: child.status });
        if (display.failureSummary) failures.push({ id: child.id, text: display.failureSummary });
      } else {
        children.push(...textElements(child, params, views));
      }
    }
    const status = block.children.some((child) => child.status === 'failed')
      ? 'failed'
      : block.children.some((child) => child.status === 'interrupted')
        ? 'interrupted'
        : block.expanded
          ? 'running'
          : 'completed';
    const names = [...new Set(tools.map((tool) => tool.toolName))].join(' / ');
    const count = tools.length > 1 ? ` (${tools.length})` : '';
    elements.push({
      ...collapsiblePanel(
        `${flowStatusLabel(status, params.locale)} · ${names}${count}${stepUsageSuffix(tools)}`,
        children,
        { expanded: block.expanded },
      ),
      element_id: flowElementId('group', block.id),
    });
    // These are siblings, not descendants of the group. Folding never hides failures.
    for (const failure of failures) {
      const id = flowElementId('failure', failure.id);
      elements.push({ ...params.md(failure.text), element_id: id });
      params.subagentChunks?.push({ kind: 'text', elementIds: [id] });
    }
  }
  return elements;
}

/**
 * The file a model is still writing. It exists only while the call has no timeline block of its
 * own, so nothing here needs a terminal-state counterpart: the write's own card takes over.
 */
function liveWriteElements(params: FormatProgressParams): FeishuCardElement[] {
  const live = params.data.liveWrite;
  if (!live) return [];
  const line = params.md(
    t('progress.writingFile', params.locale)
      .replace('{target}', shortPath(live.path ?? live.name))
      .replace('{lines}', String(live.contentLines))
      .replace('{chars}', String(live.contentChars)),
  );
  // Redact before slicing: a tail cut through a credential must not defeat redaction.
  const preview = thinkingTail(redactSensitiveContent(live.contentTail));
  return preview.text ? [line, codeBlockElement(preview.text)] : [line];
}

/** Only supplemental state, never a second copy of the timeline's model output. */
export function buildProgressContentElements(params: FormatProgressParams): FeishuCardElement[] {
  if (params.flowOptions?.mode === 'legacy') return buildLegacyContentElements(params);
  const { data, md, locale } = params;
  const elements: FeishuCardElement[] = [];
  const isDone = isFlowTerminal(data);
  const hasTrace = !!(data.timeline?.length || data.thinkingText?.trim() || data.toolLogs?.length);
  if (data.phase === 'waiting_permission' && data.permission) {
    const extraQueue =
      data.permission.queueLength > 1
        ? `\n${t('progress.labelPendingApprovals', locale)}: ${data.permission.queueLength}`
        : '';
    elements.push(
      md(
        `**${t('progress.labelCurrentWait', locale)}**\n${data.permission.toolName}\n\`\`\`\n${data.permission.input}\n\`\`\`${extraQueue}`,
      ),
    );
    elements.push(md(`**${t('progress.labelElapsedTime', locale)}** ${data.elapsedSeconds}s`));
  } else if (!isDone && !hasTrace) {
    if (data.currentTool?.input) {
      const elapsed = data.currentTool.elapsed > 0 ? ` · ${data.currentTool.elapsed}s` : '';
      elements.push(
        md(
          `**${t('progress.labelRecentAction', locale)}**\n${data.currentTool.name}: ${truncate(data.currentTool.input, 140)}${elapsed}`,
        ),
      );
    }
    elements.push(md(`**${t('progress.labelElapsedTime', locale)}** ${data.elapsedSeconds}s`));
    elements.push(...liveWriteElements(params));
  } else if (!isDone) {
    const status = [
      data.totalTools > 0 ? `${data.totalTools} tools` : '',
      `${data.elapsedSeconds}s`,
    ].filter(Boolean);
    elements.push(md(`⏳ ${status.join(' · ')}`));
    elements.push(...liveWriteElements(params));
  }

  // With a timeline, renderedText is no longer used as an error carrier. Provider failures
  // must still remain visible, including in a trace-only completion bubble.
  if (data.phase === 'failed' && data.errorMessage) {
    // Intermediate text may sit inside a folded group, so only top-level text is visible.
    const visibleText = buildFlowBlocks(data, params.flowOptions)
      .filter((block): block is FlowTextBlock => block.kind === 'text')
      .map((block) => block.text)
      .join('');
    const errorAlreadyVisible = visibleText.includes(data.errorMessage);
    if (!errorAlreadyVisible)
      elements.push(
        md(
          data.errorMessage === 'Interrupted'
            ? t('progress.titleStopped', locale)
            : `❌ ${data.errorMessage}`,
        ),
      );
  }
  if (data.apiRetry) {
    elements.push(
      md(
        `${t('progress.apiRetry', locale)} (${data.apiRetry.attempt}${data.apiRetry.maxRetries > 0 ? `/${data.apiRetry.maxRetries}` : ''})${data.apiRetry.error ? ` — ${data.apiRetry.error}` : ''}`,
      ),
    );
  }
  if (data.compacting) elements.push(md(t('progress.compacting', locale)));
  if (data.toolUseSummaryText && isDone) {
    elements.push(
      collapsiblePanel(t('progress.labelToolSummary', locale), [
        markdownElement(data.toolUseSummaryText),
      ]),
    );
  }
  if (data.todoItems.length > 0) {
    const done = data.todoItems.filter((item) => item.status === 'completed').length;
    const todoLines = data.todoItems.map((item) => `${TODO_MARKERS[item.status]} ${item.content}`);
    // One stable identity per conversation: the board is the same block on every card refresh.
    elements.push({
      ...collapsiblePanel(
        `📋 ${t('progress.labelWorkProgress', locale)} (${done}/${data.todoItems.length})`,
        [markdownElement(todoLines.join('\n'))],
        { expanded: true },
      ),
      element_id: flowElementId('plan', 'board'),
    });
  }
  return elements;
}
