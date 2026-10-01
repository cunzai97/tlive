import { describe, expect, it, vi } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { actionCallback } from '../../shared/core/callbacks.js';
import type { FeishuCardElement } from '../../server/channels/feishu/card-builder.js';
import { markdownElement } from '../../server/channels/feishu/card-elements.js';
import { planFeishuCards } from '../../server/channels/feishu/card-budget.js';
import {
  buildFlowBlocks,
  collectFlowItems,
  countFlowGapTokens,
  DEFAULT_FLOW_BLOCK_OPTIONS,
  estimatedTokenCount,
  type FlowOptions,
  type FlowTextBlock,
  type FlowTimelineEntry,
} from '../../server/channels/feishu/flow-blocks.js';
import {
  buildProgressContentElements,
  buildProgressTimelineElements,
} from '../../server/channels/feishu/format-progress.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import {
  createDefaultToolDisplayRegistry,
  ToolDisplayRegistry,
  type ToolDisplayCall,
} from '../../server/channels/feishu/tool-display.js';

function progress(overrides: Partial<ProgressData> = {}): ProgressData {
  return {
    phase: 'completed',
    taskSummary: 'flow test',
    elapsedSeconds: 5,
    renderedText: '',
    todoItems: [],
    totalTools: 0,
    ...overrides,
  };
}

function tool(name: string, id: string, overrides: Partial<FlowTimelineEntry> = {}): FlowTimelineEntry {
  return {
    kind: 'tool',
    toolName: name,
    toolId: id,
    toolInput: `${id} input`,
    toolResult: `${id} result`,
    ...overrides,
  };
}

function elements(data: ProgressData, flowOptions?: FlowOptions): FeishuCardElement[] {
  const params = { chatId: 'chat1', data, md: markdownElement, locale: 'zh' as const, flowOptions };
  return [...buildProgressTimelineElements(params), ...buildProgressContentElements(params)];
}

function descendants(items: FeishuCardElement[]): FeishuCardElement[] {
  const found: FeishuCardElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.tag === 'string') found.push(record as FeishuCardElement);
      for (const child of Object.values(record)) visit(child);
    }
  };
  visit(items);
  return found;
}

function calls(data: ProgressData) {
  return collectFlowItems(data).filter((item) => item.kind === 'tool');
}

function displayCall(overrides: Partial<ToolDisplayCall> = {}): ToolDisplayCall {
  return {
    id: 'call1', toolName: 'Read', toolInput: 'src/a.ts',
    toolResult: 'result', status: 'completed', ...overrides,
  };
}

describe('flow blocks: semantic grouping and token accounting', () => {
  it('defaults to block mode and a 50-token estimated fallback gap', () => {
    expect(DEFAULT_FLOW_BLOCK_OPTIONS).toMatchObject({
      mode: 'blocks', groupGapTokens: 50, fallbackTokenCounter: 'estimatedTokenCount',
    });
    expect(estimatedTokenCount('a'.repeat(200))).toBe(50);
    expect(estimatedTokenCount('中'.repeat(50))).toBe(50);
    expect(estimatedTokenCount('😀')).toBe(1);
  });

  it('groups different exploration names by category rather than tool name', () => {
    const blocks = buildFlowBlocks(progress({ timeline: [
      tool('Read', 'r1'), tool('Grep', 'r2'), tool('Glob', 'r3'),
    ] }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'tool_group', category: 'exploration', expanded: false });
    if (blocks[0].kind !== 'tool_group') throw new Error('Expected tool group');
    expect(blocks[0].children.map((child) => child.kind === 'tool' ? child.id : child.text))
      .toEqual(['r1', 'r2', 'r3']);
  });

  it.each([49, 50, 51])('uses an inclusive 50-token gap boundary (%i tokens)', (tokens) => {
    const blocks = buildFlowBlocks(progress({ timeline: [
      tool('Read', 'r1'), { kind: 'thinking', text: '中'.repeat(tokens) }, tool('Grep', 'r2'),
    ] }));
    expect(blocks.filter((block) => block.kind === 'tool_group')).toHaveLength(tokens <= 50 ? 1 : 2);
    expect(blocks.map((block) => block.kind)).toEqual(
      tokens <= 50 ? ['tool_group'] : ['tool_group', 'thinking', 'tool_group'],
    );
  });

  it('supports a configurable group gap instead of hard-coding 50', () => {
    const data = progress({ timeline: [
      tool('Read', 'r1'), { kind: 'text', text: '中'.repeat(11) }, tool('Read', 'r2'),
    ] });
    expect(buildFlowBlocks(data, { groupGapTokens: 10 })).toHaveLength(3);
    expect(buildFlowBlocks(data, { groupGapTokens: 11 })).toHaveLength(1);
  });

  it('calls the injected tokenizer once on the entire mixed inter-tool gap', () => {
    const countTokens = vi.fn(() => 51);
    const blocks = buildFlowBlocks(progress({ timeline: [
      tool('Read', 'r1'),
      { kind: 'thinking', text: 'think-' }, { kind: 'thinking', text: 'fragment' },
      { kind: 'text', text: 'say-' }, { kind: 'text', text: 'fragment' },
      tool('Grep', 'r2'),
    ] }), { countTokens });
    expect(countTokens).toHaveBeenCalledExactlyOnceWith('think-fragmentsay-fragment');
    expect(blocks.map((block) => block.kind)).toEqual(['tool_group', 'thinking', 'text', 'tool_group']);
  });

  it.each([50, 51])('honors injected tokenizer count %i over the estimate', (tokenCount) => {
    const countTokens = vi.fn(() => tokenCount);
    const blocks = buildFlowBlocks(progress({ timeline: [
      tool('Read', 'r1'), { kind: 'text', text: 'tiny' }, tool('Read', 'r2'),
    ] }), { countTokens });
    expect(countTokens).toHaveBeenCalledExactlyOnceWith('tiny');
    expect(blocks.filter((block) => block.kind === 'tool_group')).toHaveLength(tokenCount <= 50 ? 1 : 2);
  });

  it('prefers exact tokenCount and sums all contributing fragments and block kinds', () => {
    const countTokens = vi.fn(() => 999);
    const data = progress({ timeline: [
      tool('Read', 'r1'),
      { kind: 'thinking', text: 'a'.repeat(500), tokenCount: 20 },
      { kind: 'thinking', text: 'b'.repeat(500), tokenCount: 10 },
      { kind: 'text', text: 'c'.repeat(500), tokenCount: 20 },
      tool('Read', 'r2'),
    ] });
    const items = collectFlowItems(data);
    expect(items[1]).toMatchObject({ kind: 'thinking', tokenCount: 30, text: 'a'.repeat(500) + 'b'.repeat(500) });
    expect(buildFlowBlocks(data, { countTokens })).toHaveLength(1);
    expect(countTokens).not.toHaveBeenCalled();
    const over = progress({ timeline: [
      tool('Read', 'r1'), { kind: 'thinking', text: 'x', tokenCount: 51 }, tool('Read', 'r2'),
    ] });
    expect(buildFlowBlocks(over, { countTokens })).toHaveLength(3);
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('does not claim an exact count when one streamed fragment lacks tokenCount', () => {
    const countTokens = vi.fn(() => 51);
    const data = progress({ timeline: [
      tool('Read', 'r1'),
      { kind: 'thinking', text: 'part1', tokenCount: 1 }, { kind: 'thinking', text: 'part2' },
      tool('Read', 'r2'),
    ] });
    expect(collectFlowItems(data)[1]).toMatchObject({ text: 'part1part2', tokenCount: undefined });
    expect(buildFlowBlocks(data, { countTokens })).toHaveLength(3);
    expect(countTokens).toHaveBeenCalledExactlyOnceWith('part1part2');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('falls back for invalid tokenizer output %s', (invalid) => {
    const gap: FlowTextBlock[] = [{ kind: 'text', text: '中'.repeat(51), status: 'completed' }];
    expect(countFlowGapTokens(gap, { countTokens: () => invalid })).toBe(51);
  });

  it('accumulates small stream fragments before counting, without per-fragment rounding', () => {
    const stream = Array.from({ length: 200 }, () => ({ kind: 'thinking' as const, text: 'a' }));
    const data = progress({ timeline: [tool('Read', 'r1'), ...stream, tool('Read', 'r2')] });
    expect(collectFlowItems(data)[1]).toMatchObject({ text: 'a'.repeat(200) });
    expect(buildFlowBlocks(data)).toHaveLength(1);
    const longer = progress({ timeline: [
      tool('Read', 'r1'), ...stream, { kind: 'thinking', text: 'a' }, tool('Read', 'r2'),
    ] });
    expect(buildFlowBlocks(longer).map((block) => block.kind))
      .toEqual(['tool_group', 'thinking', 'tool_group']);
  });

  it('keeps short thinking/text in their original order inside a same-category group', () => {
    const blocks = buildFlowBlocks(progress({ timeline: [
      tool('Read', 'r1'), { kind: 'thinking', text: 'think1' }, { kind: 'text', text: 'text1' },
      { kind: 'thinking', text: 'think2' }, tool('Grep', 'r2'),
    ] }));
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== 'tool_group') throw new Error('Expected tool group');
    expect(blocks[0].children.map((child) => child.kind === 'tool' ? child.id : child.text))
      .toEqual(['r1', 'think1', 'text1', 'think2', 'r2']);
    const nested = elements(progress({ timeline: [
      tool('Read', 'r1'), { kind: 'thinking', text: 'think1' }, { kind: 'text', text: 'text1' },
      { kind: 'thinking', text: 'think2' }, tool('Grep', 'r2'),
    ] }))[0].elements ?? [];
    expect(nested.map((item) => item.tag)).toEqual(['markdown', 'collapsible_panel', 'markdown', 'collapsible_panel', 'markdown']);
    expect(nested[1].elements?.[0].content).toBe('think1');
    expect(nested[2].content).toBe('text1');
    expect(nested[3].elements?.[0].content).toBe('think2');
  });

  it('does not merge mixed categories or leap over another category', () => {
    const blocks = buildFlowBlocks(progress({ timeline: [
      tool('Read', 'r1'), { kind: 'thinking', text: 'between' }, tool('Bash', 'b1'),
      tool('Write', 'w1'), tool('Edit', 'e1'), tool('Read', 'r2'), tool('unknown', 'u1'),
    ] }));
    expect(blocks.map((block) => block.kind === 'tool_group' ? block.category : block.kind))
      .toEqual(['exploration', 'thinking', 'execution', 'editing', 'exploration', 'generic']);
  });
});

describe('flow blocks: lossless model text and call identity', () => {
  it.each(['executing', 'completed'] as const)('retains the entire long thinking text in %s phase', (phase) => {
    const thought = `FIRST_THOUGHT_${'旧思考'.repeat(700)}LAST_THOUGHT`;
    const card = elements(progress({ phase, timeline: [{ kind: 'thinking', text: thought }] }));
    expect(card[0]).toMatchObject({ tag: 'collapsible_panel', expanded: phase === 'executing' });
    expect(card[0].elements?.[0].content).toBe(thought);
    expect(JSON.stringify(card)).not.toContain('200 tokens');
    expect(card[0].body).toBeUndefined();
  });

  it('renders pre-tool text openly and final text openly without replaying renderedText', () => {
    const data = progress({ renderedText: 'beforeafter', timeline: [
      { kind: 'text', text: 'before' }, tool('Read', 'r1'), { kind: 'text', text: 'after' },
    ] });
    expect(elements(data).map((item) => item.tag)).toEqual(['markdown', 'collapsible_panel', 'markdown']);
    expect(elements(data)[0].content).toBe('before');
    expect(elements(data)[2].content).toBe('after');
    expect(JSON.stringify(elements(data)).match(/before/g)).toHaveLength(1);
    expect(JSON.stringify(elements(data)).match(/after/g)).toHaveLength(1);
  });

  it.each(['executing', 'completed'] as const)('never folds even a short trailing final text in %s phase', (phase) => {
    const data = progress({ phase, timeline: [tool('Read', 'r1'), { kind: 'text', text: 'FINAL' }] });
    expect(buildFlowBlocks(data).map((block) => block.kind)).toEqual(['tool_group', 'text']);
    expect(elements(data)[1]).toMatchObject({ tag: 'markdown', content: 'FINAL' });
  });

  it('completedTraceOnly removes only the trailing final text, preserving intermediate model text', () => {
    const data = progress({ completedTraceOnly: true, timeline: [
      { kind: 'text', text: 'INTRO' }, tool('Read', 'r1'), { kind: 'text', text: 'MIDDLE' },
      tool('Read', 'r2'), { kind: 'text', text: 'FINAL_PART1' }, { kind: 'text', text: 'FINAL_PART2' },
    ] });
    const json = JSON.stringify(elements(data));
    expect(json).toContain('INTRO');
    expect(json).toContain('MIDDLE');
    expect(json).not.toContain('FINAL_PART1');
    expect(json).not.toContain('FINAL_PART2');
  });

  it('does not delete an intermediate text when the terminal trace ends with thinking', () => {
    const data = progress({ completedTraceOnly: true, timeline: [
      tool('Read', 'r1'), { kind: 'text', text: 'KEEP' }, { kind: 'thinking', text: 'TAIL_THOUGHT' },
    ] });
    const json = JSON.stringify(elements(data));
    expect(json).toContain('KEEP');
    expect(json).toContain('TAIL_THOUGHT');
  });

  it('does not remove streaming text merely because completedTraceOnly is set', () => {
    const data = progress({ phase: 'executing', completedTraceOnly: true, timeline: [
      tool('Read', 'r1'), { kind: 'text', text: 'LIVE' },
    ] });
    expect(elements(data)[1].content).toBe('LIVE');
  });

  it('updates one stable toolId even when result and duplicate start events arrive later', () => {
    const data = progress({ timeline: [
      tool('Read', 'same-id', { toolResult: undefined }), { kind: 'thinking', text: 'gap' },
      { kind: 'tool', toolId: 'same-id', toolResult: 'COMPLETE' },
      tool('Read', 'same-id', { toolResult: undefined }),
    ] });
    expect(calls(data)).toHaveLength(1);
    expect(calls(data)[0]).toMatchObject({ id: 'same-id', status: 'completed', toolResult: 'COMPLETE' });
  });

  it('preserves separate calls with different IDs despite identical name and input', () => {
    const data = progress({ timeline: [
      tool('Read', 'first', { toolInput: 'same', toolResult: undefined }),
      tool('Read', 'second', { toolInput: 'same', toolResult: undefined }),
      { kind: 'tool', toolId: 'second', toolResult: 'SECOND' },
      { kind: 'tool', toolId: 'first', toolResult: 'FIRST' },
    ] });
    expect(calls(data).map((call) => [call.id, call.toolResult])).toEqual([['first', 'FIRST'], ['second', 'SECOND']]);
  });

  it('does not invent call identity for ID-less identical name/input payloads', () => {
    const data = progress({ timeline: [
      { kind: 'tool', toolName: 'Read', toolInput: 'same', toolResult: 'FIRST' },
      { kind: 'tool', toolName: 'Read', toolInput: 'same', toolResult: 'SECOND' },
    ] });
    expect(calls(data)).toHaveLength(2);
    expect(new Set(calls(data).map((call) => call.id)).size).toBe(2);
    expect(calls(data).map((call) => call.toolResult)).toEqual(['FIRST', 'SECOND']);
  });

  it('preserves stable IDs, structured inputs, and explicit status from toolLogs fallback', () => {
    const data = progress({ toolLogs: [
      { name: 'Read', input: 'same', toolId: 'log1', inputData: { path: 'src/a.ts' }, status: 'interrupted' },
      { name: 'Read', input: 'same', toolId: 'log2', result: 'SECOND', status: 'completed' },
    ] });
    expect(calls(data)).toMatchObject([
      { id: 'log1', inputData: { path: 'src/a.ts' }, status: 'interrupted' },
      { id: 'log2', status: 'completed', toolResult: 'SECOND' },
    ]);
  });

  it('keeps a group open while a short trailing thought is still running', () => {
    const data = progress({ phase: 'executing', timeline: [
      tool('Read', 'r1'), { kind: 'thinking', text: 'still thinking' },
    ] });
    expect(buildFlowBlocks(data)).toMatchObject([{
      kind: 'tool_group', expanded: true, children: [
        { kind: 'tool', status: 'completed' }, { kind: 'thinking', status: 'running' },
      ],
    }]);
    const card = elements(data);
    expect(card[0].expanded).toBe(true);
    expect(card[0].elements?.[1].expanded).toBe(true);
  });

  it('collapses completed calls even if the overall task is still executing', () => {
    const data = progress({ phase: 'executing', timeline: [tool('Read', 'r1')] });
    expect(elements(data)[0].expanded).toBe(false);
    const running = progress({ phase: 'executing', timeline: [tool('Read', 'r1', { toolResult: undefined })] });
    expect(elements(running)[0].expanded).toBe(true);
  });
});

describe('tool display: category policy, failures, details, and overrides', () => {
  it.each(['read', 'grab', 'Read', 'Grep', 'Glob', 'Search'])('omits successful %s output from all serialized card JSON', (name) => {
    const secret = `OUTPUT_MUST_NOT_EXIST_${'body'.repeat(100)}`;
    const card = elements(progress({ timeline: [tool(name, 'r1', { toolInput: 'VISIBLE_INPUT', toolResult: secret })] }));
    expect(JSON.stringify(card)).toContain('VISIBLE_INPUT');
    expect(JSON.stringify(card)).not.toContain('OUTPUT_MUST_NOT_EXIST');
    expect(descendants(card).filter((item) => item.header?.title.content === '完整结果')).toHaveLength(0);
  });

  it.each(['bash', 'Bash'])('keeps the complete %s command and full result in a nested fold', (name) => {
    const command = `COMMAND_START_${'command-arg '.repeat(100)}COMMAND_END`;
    const output = `RESULT_START_${'output line\n'.repeat(100)}RESULT_END`;
    const card = elements(progress({ timeline: [tool(name, 'b1', { toolInput: command, toolResult: output })] }));
    expect(card[0].elements?.[0].content).toContain(command);
    const full = descendants(card).find((item) => item.header?.title.content === '完整结果');
    expect(full).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(full?.elements?.[0].content).toBe(output);
    expect(full?.body).toBeUndefined();
  });

  it('renders a failure summary outside its collapsed parent fold', () => {
    const data = progress({ timeline: [tool('Read', 'r1', { isError: true, toolResult: 'READ_FAILED_MARKER' })] });
    const card = elements(data);
    expect(card[0]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(card[1]).toMatchObject({ tag: 'markdown' });
    expect(card[1].content).toContain('失败');
    expect(card[1].content).toContain('READ_FAILED_MARKER');
    expect(card[0].header?.title.content).toContain('失败');
  });

  it('shows a provider failure outside folds even when trace-only removes the final answer', () => {
    const data = progress({ phase: 'failed', completedTraceOnly: true, errorMessage: 'PROVIDER_FAILED', timeline: [
      tool('Read', 'r1'), { kind: 'text', text: 'final answer' },
    ] });
    const card = elements(data);
    expect(card.some((item) => item.tag === 'markdown' && item.content?.includes('PROVIDER_FAILED'))).toBe(true);
    expect(JSON.stringify(card)).not.toContain('final answer');
  });

  it('marks pending tools and active thought interrupted on stop and leaves no running folds', () => {
    const data = progress({ phase: 'failed', errorMessage: 'Interrupted', timeline: [
      tool('Bash', 'b1', { toolResult: undefined }), { kind: 'thinking', text: 'in progress' },
    ] });
    expect(collectFlowItems(data)).toMatchObject([
      { kind: 'tool', status: 'interrupted' }, { kind: 'thinking', status: 'interrupted' },
    ]);
    const card = elements(data);
    expect(descendants(card).filter((item) => item.tag === 'collapsible_panel').every((item) => !item.expanded)).toBe(true);
    expect(card[0].header?.title.content).toContain('已中断');
    expect(card.some((item) => item.tag === 'markdown' && item.content?.includes('已中断'))).toBe(true);
    expect(card.some((item) => item.tag === 'markdown' && item.content?.includes('已停止'))).toBe(true);
  });

  it.each([
    ['Write', '查看新增内容'], ['write', '查看新增内容'],
    ['Edit', '查看改动'], ['replace', '查看改动'], ['MultiEdit', '查看改动'],
  ])('renders %s file entries and a snapshot detail button only when detailId exists', (name, label) => {
    const registry = createDefaultToolDisplayRegistry();
    expect(registry.category(name)).toBe('editing');
    const call = displayCall({ toolName: name, inputData: { path: 'src/a.ts', edits: [{ file_path: 'src/b.ts' }] }, detailId: '12345678-1234-4234-8234-123456789abc' });
    const card = registry.display(call, 'zh').elements;
    expect(JSON.stringify(card)).toContain('src/a.ts');
    expect(JSON.stringify(card)).toContain('src/b.ts');
    const buttons = descendants(card).filter((item) => item.tag === 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      text: { tag: 'plain_text', content: label },
      behaviors: [{ type: 'callback', value: { action: 'flow_detail:open:12345678-1234-4234-8234-123456789abc' } }],
    });
    expect(descendants(registry.display({ ...call, detailId: undefined }, 'zh').elements)
      .filter((item) => item.tag === 'button')).toHaveLength(0);
  });

  it('defaults unknown names to generic without guessing aliases', () => {
    const registry = createDefaultToolDisplayRegistry();
    expect(registry.category('READ')).toBe('generic');
    expect(registry.category('my_read')).toBe('generic');
    const card = registry.display(displayCall({ toolName: 'my_read', toolResult: 'GENERIC_OUTPUT' }), 'zh').elements;
    expect(JSON.stringify(card)).toContain('my_read');
    expect(descendants(card).find((item) => item.header?.title.content === '完整结果')?.elements?.[0].content)
      .toBe('GENERIC_OUTPUT');
  });

  it('supports category registration, aliases, and renderer override without renaming tools', () => {
    const render = vi.fn((call: ToolDisplayCall) => ({ elements: [markdownElement(`CUSTOM:${call.id}`)] }));
    const registry = new ToolDisplayRegistry()
      .register(['custom_read', 'alias_read'], 'exploration')
      .register('custom_run', { category: 'execution', render });
    expect(registry.category('alias_read')).toBe('exploration');
    registry.register('alias_read', 'execution');
    const card = elements(progress({ timeline: [tool('alias_read', 'a1'), tool('custom_run', 'c1')] }), { registry });
    expect(card.filter((item) => item.tag === 'collapsible_panel')).toHaveLength(1);
    expect(card[0].header?.title.content).toContain('alias_read / custom_run');
    expect(JSON.stringify(card)).toContain('CUSTOM:c1');
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'c1', toolName: 'custom_run' }), 'zh');
  });

  it('a custom renderer cannot hide failures inside its parent fold', () => {
    const registry = new ToolDisplayRegistry().register('custom', {
      category: 'generic', render: () => ({ elements: [markdownElement('CUSTOM_BODY')] }),
    });
    const card = elements(progress({ timeline: [tool('custom', 'c1', { status: 'failed', toolResult: 'CUSTOM_FAILED' })] }), { registry });
    expect(card[0].expanded).toBe(false);
    expect(card[1]).toMatchObject({ tag: 'markdown' });
    expect(card[1].content).toContain('CUSTOM_FAILED');
  });
});

describe('FeishuFormatter block-mode integration', () => {
  it('uses blocks by default and keeps the stop action outside every fold', () => {
    const formatter = new FeishuFormatter('zh');
    const msg = formatter.formatProgress('chat1', progress({ phase: 'executing', timeline: [
      tool('Read', 'r1', { toolResult: undefined }), { kind: 'thinking', text: 'working' },
    ] }));
    const card = (msg.feishuElements ?? []) as FeishuCardElement[];
    expect(card[0].header?.title.content).toContain('探索工具');
    const outsideButtons = descendants(card.filter((item) => item.tag !== 'collapsible_panel')).filter((item) => item.tag === 'button');
    expect(outsideButtons).toContainEqual(expect.objectContaining({
      behaviors: [{ type: 'callback', value: { action: actionCallback('stop') } }],
    }));
    expect(descendants([card[0]]).filter((item) => item.tag === 'button')).toHaveLength(0);
  });

  it('passes injected flowOptions through the formatter to grouping and custom display', () => {
    const registry = new ToolDisplayRegistry().register('custom', 'exploration');
    const countTokens = vi.fn(() => 51);
    const formatter = new FeishuFormatter('zh', { flowOptions: { mode: 'blocks', registry, countTokens } });
    const msg = formatter.formatProgress('chat1', progress({ timeline: [
      tool('custom', 'c1'), { kind: 'thinking', text: 'gap' }, tool('custom', 'c2'),
    ] }));
    expect(countTokens).toHaveBeenCalledExactlyOnceWith('gap');
    const card = (msg.feishuElements ?? []) as FeishuCardElement[];
    expect(card.filter((item) => item.header?.title.content.includes('探索工具'))).toHaveLength(2);
    expect(JSON.stringify(msg.feishuElements)).not.toContain('c1 result');
  });
});

describe('flow regression: provider counts, valid details and stable streaming identity', () => {
  it('does not hide a provider error that also occurs in folded intermediate text', () => {
    const card = elements(progress({ phase: 'failed', errorMessage: 'PROVIDER_ERROR', timeline: [
      tool('Read', 'r1'), { kind: 'text', text: 'PROVIDER_ERROR' }, tool('Read', 'r2'),
    ] }));
    expect(card.some((element) => element.tag === 'markdown' && element.content?.includes('PROVIDER_ERROR'))).toBe(true);
  });

  it.each(['exactTokenCount', 'exacttokenCount'] as const)('accepts provider %s on accumulated fragments', (field) => {
    const countTokens = vi.fn(() => 999);
    const data = progress({ timeline: [
      tool('Read', 'r1'),
      { kind: 'thinking', text: 'a'.repeat(400), [field]: 25 },
      { kind: 'thinking', text: 'b'.repeat(400), [field]: 25 },
      tool('Read', 'r2'),
    ] });
    expect(collectFlowItems(data)[1]).toMatchObject({ tokenCount: 50 });
    expect(buildFlowBlocks(data, { countTokens })).toHaveLength(1);
    expect(countTokens).not.toHaveBeenCalled();
  });

  it.each(['', 'snapshot_123', '12345678-1234-1234-8234-123456789abc', ' ../../file'])('does not manufacture a detail button for invalid ID %j', (detailId) => {
    const result = createDefaultToolDisplayRegistry().display(displayCall({ toolName: 'Write', detailId }), 'zh');
    expect(descendants(result.elements).filter((element) => element.tag === 'button')).toHaveLength(0);
  });

  it('keeps group and existing call element IDs stable when short text and calls join the group', () => {
    const before = elements(progress({ timeline: [tool('Read', 'long-provider-id-'.repeat(20)), tool('Grep', 'r2')] }));
    const after = elements(progress({ timeline: [
      tool('Read', 'long-provider-id-'.repeat(20)), { kind: 'thinking', text: 'short' },
      { kind: 'text', text: 'still short' }, tool('Grep', 'r2'), tool('Glob', 'r3'),
    ] }));
    expect(after[0].element_id).toBe(before[0].element_id);
    expect(after[0].elements?.[0].element_id).toBe(before[0].elements?.[0].element_id);
    expect(after[0].elements?.[3].element_id).toBe(before[0].elements?.[1].element_id);
    const ids = descendants(after).map((element) => element.element_id).filter((id) => typeof id === 'string');
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.every((id) => /^[a-zA-Z0-9_]{1,20}$/.test(id as string))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('retains sealed budget history when a growing group receives short interleaved text', () => {
    const timeline = [
      tool('Read', 'r1', { toolInput: `FIRST_${'a'.repeat(1800)}` }),
      tool('Grep', 'r2', { toolInput: `SECOND_${'b'.repeat(1800)}` }),
    ];
    const card = (entries: FlowTimelineEntry[]) => ({ schema: '2.0', body: { elements: elements(progress({ timeline: entries })) } });
    const budget = { maxBytes: 1400, maxElements: 160, maxTables: 5 };
    const before = planFeishuCards(card(timeline), budget);
    expect(before.length).toBeGreaterThan(1);
    const after = planFeishuCards(card([
      timeline[0], { kind: 'thinking', text: 'brief' }, { kind: 'text', text: 'narration' }, timeline[1], tool('Glob', 'r3'),
    ]), budget, before);
    const keys = new Set(after.flatMap((page) => page.slices.map((slice) => slice.key)));
    for (const page of before.filter((page) => page.sealed)) {
      for (const slice of page.slices) expect(keys.has(slice.key)).toBe(true);
    }
    const rendered = after.flatMap((page) => descendants(JSON.parse(page.content).body.elements))
      .filter((element) => element.tag === 'markdown').map((element) => element.content ?? '').join('');
    expect(rendered).toContain(`FIRST_${'a'.repeat(1800)}`);
    expect(rendered).toContain(`SECOND_${'b'.repeat(1800)}`);
    expect(rendered).toContain('narration');
  });

  it('keeps ID-less calls stable when a short thought is inserted ahead of a later call', () => {
    const call = { kind: 'tool' as const, toolName: 'Read', toolInput: 'same' };
    const before = calls(progress({ timeline: [call, call] })).map((entry) => entry.id);
    const after = calls(progress({ timeline: [call, { kind: 'thinking', text: 'short' }, call] })).map((entry) => entry.id);
    expect(after).toEqual(before);
  });
});
