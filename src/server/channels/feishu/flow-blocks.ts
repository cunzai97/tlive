import type { ProgressData } from '../../../shared/formatting/message-types.js';
import {
  createDefaultToolDisplayRegistry,
  type FlowStatus,
  type ToolDisplayCall,
  type ToolDisplayCategory,
  type ToolDisplayRegistry,
} from './tool-display.js';

/**
 * Display configuration, not tokenizer configuration. Without tokenCount/countTokens,
 * grouping uses estimatedTokenCount: ASCII ~1/4 token, non-ASCII code point ~1.
 * This fallback is an estimate, never a real model tokenizer or usage measurement.
 */
export interface FlowOptions {
  mode?: 'blocks' | 'legacy';
  groupGapTokens?: number;
  /** Real tokenizer hook, invoked on the complete inter-tool gap, not stream packets. */
  countTokens?: (text: string) => number;
  registry?: ToolDisplayRegistry;
}

export const DEFAULT_FLOW_BLOCK_OPTIONS = {
  mode: 'blocks',
  groupGapTokens: 50,
  fallbackTokenCounter: 'estimatedTokenCount',
} as const;

export type FlowTimelineEntry = NonNullable<ProgressData['timeline']>[number] & {
  toolId?: string;
  inputData?: Record<string, unknown>;
  status?: FlowStatus;
  detailId?: string;
  tokenCount?: number;
};

export interface FlowTextBlock {
  id?: string;
  kind: 'thinking' | 'text';
  text: string;
  status: FlowStatus;
  /** Present only if every contributing entry supplied a real tokenCount. */
  tokenCount?: number;
}

export interface FlowToolBlock extends ToolDisplayCall {
  kind: 'tool';
  category: ToolDisplayCategory;
}

export interface FlowToolGroup {
  kind: 'tool_group';
  category: ToolDisplayCategory;
  children: Array<FlowTextBlock | FlowToolBlock>;
  expanded: boolean;
}

export type FlowBlock = FlowTextBlock | FlowToolGroup;

export function estimatedTokenCount(text: string): number {
  let units = 0;
  for (const char of text) units += (char.codePointAt(0) ?? 0) <= 0x7f ? 1 : 4;
  return Math.ceil(units / 4);
}

function validCount(count: number | undefined): count is number {
  return count !== undefined && Number.isFinite(count) && count >= 0;
}

export function countFlowGapTokens(blocks: readonly FlowTextBlock[], options: FlowOptions = {}): number {
  if (blocks.every((block) => validCount(block.tokenCount))) {
    return blocks.reduce((sum, block) => sum + (block.tokenCount ?? 0), 0);
  }
  const text = blocks.map((block) => block.text).join('');
  if (options.countTokens) {
    const count = options.countTokens(text);
    if (validCount(count)) return count;
  }
  return estimatedTokenCount(text);
}

export function isFlowTerminal(data: ProgressData): boolean {
  return data.phase === 'completed' || data.phase === 'failed';
}

/** Remove renderer-added footer/summary, never a text-size budget. */
export function progressBodyWithoutMetadata(data: ProgressData): string {
  let body = data.renderedText.trim();
  for (const suffix of [data.footerLine, data.toolSummary, '───────────────']) {
    if (suffix && body.endsWith(suffix)) body = body.slice(0, -suffix.length).trimEnd();
  }
  return body;
}

function terminalStatus(data: ProgressData): FlowStatus {
  return data.phase === 'failed'
    ? data.errorMessage === 'Interrupted' ? 'interrupted' : 'failed'
    : 'completed';
}

function entriesForData(data: ProgressData): FlowTimelineEntry[] {
  if (data.timeline?.length) return data.timeline;
  const entries: FlowTimelineEntry[] = [];
  if (data.thinkingText?.trim()) entries.push({ kind: 'thinking', text: data.thinkingText });
  for (const log of data.toolLogs ?? []) {
    entries.push({ kind: 'tool', toolName: log.name, toolInput: log.input, toolResult: log.result, isError: log.isError });
  }
  return entries;
}

/** Build semantic blocks first, including all streaming fragments and ID-based result updates. */
export function collectFlowItems(
  data: ProgressData,
  registry: ToolDisplayRegistry = createDefaultToolDisplayRegistry(),
): Array<FlowTextBlock | FlowToolBlock> {
  const items: Array<FlowTextBlock | FlowToolBlock> = [];
  const toolById = new Map<string, FlowToolBlock>();
  const entries = entriesForData(data);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.kind === 'tool') {
      const existing = entry.toolId ? toolById.get(entry.toolId) : undefined;
      if (!entry.toolName && !existing) continue;
      const inferredStatus = entry.isError ? 'failed'
        : entry.toolResult !== undefined ? 'completed' : 'running';
      const status = entry.status ?? inferredStatus;
      if (existing) {
        if (entry.toolInput !== undefined) existing.toolInput = entry.toolInput;
        if (entry.inputData !== undefined) existing.inputData = entry.inputData;
        if (entry.toolResult !== undefined) existing.toolResult = entry.toolResult;
        if (entry.detailId !== undefined) existing.detailId = entry.detailId;
        // Delayed/repeated start events cannot reopen a completed call.
        if (status !== 'running' || existing.status === 'running') existing.status = status;
        continue;
      }
      const tool: FlowToolBlock = {
        kind: 'tool',
        // ID-less old payloads are distinct calls; never guess identity from identical input.
        id: entry.toolId ?? `legacy-call:${index}`,
        toolName: entry.toolName ?? '',
        toolInput: entry.toolInput ?? '',
        inputData: entry.inputData,
        toolResult: entry.toolResult,
        status,
        detailId: entry.detailId,
        category: registry.category(entry.toolName ?? ''),
      };
      if (entry.toolId) toolById.set(entry.toolId, tool);
      items.push(tool);
    } else if (entry.text !== undefined && entry.text.length) {
      const previous = items[items.length - 1];
      const status = entry.status ?? 'completed';
      // Adjacent chunks are one semantic block: no inserted spaces or per-packet rounding.
      if (previous && previous.kind === entry.kind) {
        previous.text += entry.text;
        previous.status = status;
        previous.tokenCount = validCount(previous.tokenCount) && validCount(entry.tokenCount)
          ? previous.tokenCount + entry.tokenCount : undefined;
      } else {
        items.push({ id: entry.blockId ?? `text:${index}`, kind: entry.kind, text: entry.text, status, tokenCount: validCount(entry.tokenCount) ? entry.tokenCount : undefined });
      }
    }
  }

  // Legacy/no-text payloads still display their answer. Timeline text is authoritative and
  // must not be replayed via renderedText (which includes all preceding model narration).
  const body = progressBodyWithoutMetadata(data);
  if (!items.some((item) => item.kind === 'text') && body) {
    items.push({ id: 'fallback-body', kind: 'text', text: body, status: isFlowTerminal(data) ? terminalStatus(data) : 'running' });
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind === 'tool') {
      if (isFlowTerminal(data) && item.status === 'running') item.status = terminalStatus(data);
    } else if (item.kind === 'thinking') {
      const isLatest = index === items.length - 1;
      const lastEntry = entries[entries.length - 1];
      if (isFlowTerminal(data)) {
        if (item.status === 'running' || isLatest) item.status = terminalStatus(data);
      } else if (isLatest && lastEntry?.kind === 'thinking' && lastEntry.status === undefined) {
        item.status = 'running';
      } else if (!isLatest && item.status === 'running') {
        item.status = 'completed';
      }
    }
  }
  return items;
}

export function buildFlowBlocks(data: ProgressData, options: FlowOptions = {}): FlowBlock[] {
  const registry = options.registry ?? createDefaultToolDisplayRegistry();
  const items = collectFlowItems(data, registry);
  if (isFlowTerminal(data) && data.completedTraceOnly) {
    // Only the contiguous trailing answer is sent separately. Intermediate model text stays.
    while (items[items.length - 1]?.kind === 'text') items.pop();
  }
  const blocks: FlowBlock[] = [];
  const configuredGap = options.groupGapTokens ?? DEFAULT_FLOW_BLOCK_OPTIONS.groupGapTokens;
  const maxGap = Number.isFinite(configuredGap) ? Math.max(0, configuredGap) : 50;
  let group: FlowToolGroup | undefined;
  let pending: FlowTextBlock[] = [];
  const finishGroup = (): void => {
    if (group) {
      group.expanded = group.children.some((child) => child.status === 'running');
      blocks.push(group);
      group = undefined;
    }
  };
  for (const item of items) {
    if (item.kind !== 'tool') {
      if (group) pending.push(item);
      else blocks.push(item);
      continue;
    }
    if (group && group.category === item.category && countFlowGapTokens(pending, options) <= maxGap) {
      group.children.push(...pending, item);
    } else {
      finishGroup();
      blocks.push(...pending);
      group = { kind: 'tool_group', category: item.category, children: [item], expanded: false };
    }
    pending = [];
  }
  // Trailing model output is never folded just because a tool preceded it. A short, active
  // trailing thought may live in the group; its parent must remain expanded while thinking.
  if (group && pending.length && pending.every((block) => block.kind === 'thinking')
    && countFlowGapTokens(pending, options) <= maxGap) {
    group.children.push(...pending);
    pending = [];
  }
  finishGroup();
  blocks.push(...pending);
  return blocks;
}
