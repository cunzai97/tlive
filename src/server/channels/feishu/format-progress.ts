/** Lossless block-format progress cards; phase-summary formatting remains opt-in legacy. */
import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { ProgressData } from '../../../shared/formatting/message-types.js';
import { truncate } from '../../../shared/core/string.js';
import type { FeishuCardElement } from './card-builder.js';
import { collapsiblePanel, markdownElement } from './card-elements.js';
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

function textElements(block: FlowTextBlock, params: FormatProgressParams): FeishuCardElement[] {
  if (!block.text.trim()) return [];
  const identity = block.id ?? block.kind;
  const text = { ...params.md(block.text), element_id: flowElementId('text', identity) };
  if (block.kind === 'text') return [text];
  return [
    {
      ...collapsiblePanel(
        `${flowStatusLabel(block.status, params.locale)} · ${t('progress.labelThinkingProcess', params.locale)}`,
        [text],
        { expanded: block.status === 'running' },
      ),
      element_id: flowElementId('thinking', identity),
    },
  ];
}

export function buildProgressTimelineElements(params: FormatProgressParams): FeishuCardElement[] {
  if (params.flowOptions?.mode === 'legacy') return buildLegacyTimelineElements(params);
  const registry = params.flowOptions?.registry ?? createDefaultToolDisplayRegistry();
  const blocks = buildFlowBlocks(params.data, { ...params.flowOptions, registry });
  const elements: FeishuCardElement[] = [];
  const categoryNames =
    params.locale === 'zh'
      ? { exploration: '探索工具', execution: '运行工具', editing: '编辑工具', generic: '通用工具' }
      : {
          exploration: 'Explore tools',
          execution: 'Run tools',
          editing: 'Edit tools',
          generic: 'Tools',
        };
  for (const block of blocks) {
    if (block.kind !== 'tool_group') {
      elements.push(...textElements(block, params));
      continue;
    }
    const children: FeishuCardElement[] = [];
    const failures: Array<{ id: string; text: string }> = [];
    const tools = block.children.filter((child) => child.kind === 'tool');
    for (const child of block.children) {
      if (child.kind === 'tool') {
        const display = registry.display(child, params.locale);
        children.push(...display.elements);
        if (display.failureSummary) failures.push({ id: child.id, text: display.failureSummary });
      } else {
        children.push(...textElements(child, params));
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
    elements.push({
      ...collapsiblePanel(
        `${flowStatusLabel(status, params.locale)} · ${categoryNames[block.category]} (${tools.length}) · ${names}`,
        children,
        { expanded: block.expanded },
      ),
      element_id: flowElementId('group', block.id),
    });
    // These are siblings, not descendants of the group. Folding never hides failures.
    for (const failure of failures)
      elements.push({
        ...params.md(failure.text),
        element_id: flowElementId('failure', failure.id),
      });
  }
  return elements;
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
  } else if (!isDone) {
    const status = [
      data.totalTools > 0 ? `${data.totalTools} tools` : '',
      `${data.elapsedSeconds}s`,
    ].filter(Boolean);
    elements.push(md(`⏳ ${status.join(' · ')}`));
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
    const todoLines = data.todoItems.map((item) => {
      const icon = item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🔧' : '⬜';
      return `${icon} ${item.content}`;
    });
    elements.push(
      md(
        `**${t('progress.labelWorkProgress', locale)}** (${done}/${data.todoItems.length})\n${todoLines.join('\n')}`,
      ),
    );
  }
  return elements;
}
