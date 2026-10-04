import { describe, expect, it, vi } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { progressStreamingElementIds } from '../../server/channels/feishu/format-progress.js';
import { estimatedTokenCount } from '../../server/channels/feishu/flow-blocks.js';
import { flowElementId } from '../../server/channels/feishu/tool-display.js';
import type { FeishuToolDetails } from '../../server/channels/feishu/tool-details.js';
import { FEISHU_THINKING_PREVIEW_TOKENS, FEISHU_THINKING_SEGMENT_TOKENS, thinkingSegments, thinkingTail } from '../../server/channels/feishu/thinking-preview.js';

function nodes(value: unknown): Array<Record<string, any>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value as Record<string, any>, ...Object.values(value).flatMap(nodes)];
}
const progress = (timeline: ProgressData['timeline'], extra: Partial<ProgressData> = {}): ProgressData => ({
  turnId: 'turn', phase: 'executing', taskSummary: '任务', renderedText: '', totalTools: 0,
  elapsedSeconds: 1, todoItems: [], actionButtons: [], timeline, ...extra,
});
function fixture(available = true) {
  const retained = new Map<string, { text: string; status?: string }>();
  const registerThinking = vi.fn((_chat: string, entry: { thinkingId: string; text: string; status?: string }) => {
    if (!available) return undefined;
    retained.set(entry.thinkingId, { text: entry.text, status: entry.status });
    return `opaque-${entry.thinkingId}`;
  });
  const details = { registerThinking, register: vi.fn() } as unknown as FeishuToolDetails;
  return { formatter: new FeishuFormatter('zh', { toolDetails: details }), retained, registerThinking };
}

describe('bounded body preview helper, now only the live write tail', () => {
  it('defaults to an explicit 300-token estimate', () => {
    expect(FEISHU_THINKING_PREVIEW_TOKENS).toBe(300);
    const tail = thinkingTail('旧'.repeat(10000) + '新'.repeat(300));
    expect(tail).toEqual({ text: '新'.repeat(300), tokens: 300, omitted: true });
  });
  it('keeps ASCII and mixed-language tails within the same estimate', () => {
    expect(thinkingTail('x'.repeat(10000))).toEqual({ text: 'x'.repeat(1200), tokens: 300, omitted: true });
    const mixed = thinkingTail('前'.repeat(1000) + 'ab🐾中文cd'.repeat(100));
    expect(mixed.tokens).toBeLessThanOrEqual(300);
    expect(estimatedTokenCount(mixed.text)).toBe(mixed.tokens);
    expect(('前'.repeat(1000) + 'ab🐾中文cd'.repeat(100)).endsWith(mixed.text)).toBe(true);
  });
  it('does not split astral Unicode and preserves blank lines and trailing whitespace', () => {
    expect(thinkingTail('开始🐾🐾', 1).text).toBe('🐾');
    expect(thinkingTail('前'.repeat(1000) + '\r\n尾\n\n  ', 3).text).toBe('\r\n尾\n\n  ');
    expect(thinkingTail('短文本\n')).toEqual({ text: '短文本\n', tokens: 4, omitted: false });
  });
  it('handles empty/zero or malformed limits without inventing content', () => {
    expect(thinkingTail('')).toEqual({ text: '', tokens: 0, omitted: false });
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(thinkingTail('旧内容', budget)).toEqual({ text: '', tokens: 0, omitted: true });
  });
});

describe('whole-segment cuts, so a published boundary never moves', () => {
  it('cuts from the left at the estimate the sliding preview used', () => {
    expect(FEISHU_THINKING_SEGMENT_TOKENS).toBe(300);
    expect(thinkingSegments('思'.repeat(1000)).map((part) => part.text.length)).toEqual([300, 300, 300, 100]);
    expect(thinkingSegments('思'.repeat(1000)).map((part) => part.index)).toEqual([0, 1, 2, 3]);
    expect(thinkingSegments('x'.repeat(5000)).map((part) => part.text.length)).toEqual([1200, 1200, 1200, 1200, 200]);
  });
  it('keeps every earlier segment byte-identical as the text grows', () => {
    const short = thinkingSegments('旧'.repeat(290));
    const long = thinkingSegments('旧'.repeat(290) + '新'.repeat(610));
    expect(long[0].text).toBe(short[0].text + '新'.repeat(10));
    expect(long[1].text).toBe('新'.repeat(300));
    expect(long.map((part) => part.text.length)).toEqual([300, 300, 300]);
  });
  it('prefers a line end, because heading downgrading works per line', () => {
    const [first, second] = thinkingSegments(`${'句'.repeat(200)}\n${'句'.repeat(200)}\n`);
    expect(first.text).toBe(`${'句'.repeat(200)}\n`);
    expect(second.text).toBe(`${'句'.repeat(200)}\n`);
  });
  it('does not split an astral code point and loses no character', () => {
    const parts = thinkingSegments('🐾'.repeat(400));
    expect(parts.map((part) => part.text)).toEqual(['🐾'.repeat(300), '🐾'.repeat(100)]);
    expect(parts.map((part) => part.text.length)).toEqual([600, 200]);
  });
  it('returns nothing for empty text or a budget that cannot hold a character', () => {
    expect(thinkingSegments('')).toEqual([]);
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(thinkingSegments('内容', budget)).toEqual([]);
  });
});

describe('thinking bodies published as whole segments', () => {
  const body = (message: ReturnType<FeishuFormatter['formatProgress']>, identity: string): string =>
    String(nodes(message).find(node => node.element_id === flowElementId('text', identity))?.content ?? '');
  const render = (text: string, extra: Partial<ProgressData> = {}) => {
    const { formatter } = fixture();
    return formatter.formatProgress('chat', progress([{ kind: 'thinking', blockId: 'thought', text }], extra));
  };

  it('caps a long thought at its newest segments instead of rewriting it', () => {
    const { formatter, retained } = fixture();
    const full = '头'.repeat(300) + '尾'.repeat(700);
    const data = progress([{ kind: 'thinking', blockId: 'thought', text: full }], { renderedText: full });
    const original = structuredClone(data);
    const message = formatter.formatProgress('chat', data);
    const json = JSON.stringify(message);
    // The two newest segments are on the card, whole. Dropping the head as a whole block is what a
    // client can render; re-cutting it to a moving tail is the wipe-and-reprint the old window did.
    expect(body(message, 'thought#2')).toBe('尾'.repeat(300));
    expect(body(message, 'thought#3')).toBe('尾'.repeat(100));
    expect(body(message, 'thought#0')).toBe('');
    expect(json).not.toContain('头');
    expect(json).toContain('查看完整思考');
    expect(json).not.toContain('仅显示最近约 300 Token');
    expect(retained.get('turn:thought')!.text).toBe(full);
    expect(data).toEqual(original);
    expect(nodes(message).find(node => node.tag === 'collapsible_panel')!.expanded).toBe(true);
    expect(message.feishuSnapshot).toBe(true);
  });
  it('keeps the payload the same size however long the thought becomes', () => {
    const first = JSON.stringify(render('旧'.repeat(30_000)));
    const later = JSON.stringify(render('旧'.repeat(60_000)));
    expect(first.length).toBe(later.length);
    expect(JSON.parse(later)).not.toEqual(JSON.parse(first));
  });
  it('appends to a published segment, then retires it whole when the window moves on', () => {
    const growing = render('旧'.repeat(290));
    const appended = render('旧'.repeat(290) + '新'.repeat(20));
    expect(body(appended, 'thought#0').startsWith(body(growing, 'thought#0'))).toBe(true);
    expect(body(appended, 'thought#1')).toBe('新'.repeat(10));
    // Past two segments the oldest leaves the card as one block — the behaviour the user expects.
    const rolled = render('旧'.repeat(290) + '新'.repeat(420));
    expect(body(rolled, 'thought#0')).toBe('');
    expect(body(rolled, 'thought#1')).toBe('新'.repeat(300));
    expect(body(rolled, 'thought#2')).toBe('新'.repeat(110));
  });
  it('shares one two-segment budget across thoughts and keeps starved history reachable', () => {
    const { formatter } = fixture();
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'old', text: '旧'.repeat(300) },
      { kind: 'tool', toolId: 'one', toolName: 'Read', status: 'completed', toolResult: 'ok' },
      { kind: 'thinking', blockId: 'middle', text: '中'.repeat(300) },
      { kind: 'tool', toolId: 'two', toolName: 'Read', status: 'completed', toolResult: 'ok' },
      { kind: 'thinking', blockId: 'latest', text: '最'.repeat(300) },
    ]));
    expect(body(message, 'old#0')).toBe('');
    expect(body(message, 'middle#0')).toBe('中'.repeat(300));
    expect(body(message, 'latest#0')).toBe('最'.repeat(300));
    expect(nodes(message).some(node => node.element_id === flowElementId('thinking', 'old'))).toBe(true);
    // Only a thought with text off-card asks for the detail panel; a fully shown one does not.
    expect(nodes(message).filter(node => node.tag === 'button' && node.text?.content === '查看完整思考')).toHaveLength(1);
  });
  it('publishes model prose uncapped', () => {
    const { formatter } = fixture();
    const text = '模型正文不裁剪'.repeat(700);
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'thought', text: '思考'.repeat(1000) },
      { kind: 'text', blockId: 'answer', text },
    ]));
    expect(JSON.stringify(message)).toContain(text);
  });
  it('lists exactly the thought segments the card carries, newest last', () => {
    const { formatter } = fixture();
    const data = progress([{ kind: 'thinking', blockId: 'thought', text: '旧'.repeat(1000) }]);
    const present = new Set(nodes(formatter.formatProgress('chat', data)).map(node => node.element_id));
    const ids = progressStreamingElementIds(data, {}, true);
    expect(ids).toEqual([flowElementId('text', 'thought#2'), flowElementId('text', 'thought#3')]);
    // A streaming ID the card does not have is how a page ends up never finishing its animation.
    expect(ids.every(id => present.has(id))).toBe(true);
    const uncapped = progress([{ kind: 'thinking', blockId: 'thought', text: '旧'.repeat(1000) }], { turnId: undefined });
    expect(progressStreamingElementIds(uncapped, {}, false)).toEqual([flowElementId('text', 'thought#0')]);
  });
  it('keeps detail identity stable while a thought grows past its first segment', () => {
    const actions = (message: ReturnType<FeishuFormatter['formatProgress']>) => nodes(message)
      .filter(node => node.tag === 'button' && node.text?.content === '查看完整思考')
      .map(node => node.value?.action);
    const first = render('旧'.repeat(400) + '尾'.repeat(300));
    const huge = render('旧'.repeat(400) + '尾'.repeat(300) + '继续'.repeat(9000));
    expect(actions(huge)).toEqual(actions(first));
  });
  it('publishes the whole thought when no detail store is configured to hold history', () => {
    const full = '不能丢'.repeat(1000);
    const message = new FeishuFormatter('zh').formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'thought', text: full },
    ]));
    expect(body(message, 'thought#0')).toBe(full);
    expect(JSON.stringify(message)).not.toContain('查看完整思考');
  });
  it('still shows the newest segments, without a button, if retention refuses the block', () => {
    const { formatter } = fixture(false);
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'thought', text: '旧'.repeat(1000) },
    ]));
    expect(body(message, 'thought#2')).toBe('旧'.repeat(300));
    expect(body(message, 'thought#3')).toBe('旧'.repeat(100));
    expect(JSON.stringify(message)).not.toContain('查看完整思考');
  });
  it('redacts a long credential before any segment boundary can cut through it', () => {
    const { formatter } = fixture();
    const synthetic = 'sk-' + 'A'.repeat(2000);
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'thought', text: `${'旧'.repeat(400)} ${synthetic} ${'尾'.repeat(400)}` },
    ]));
    const json = JSON.stringify(message);
    expect(json).toContain('[REDACTED]');
    expect(json).not.toContain('A'.repeat(50));
  });
  it('hands thought text to Feishu as markdown, downgrading its headings like the answer', () => {
    const { formatter } = fixture();
    const thought = '# 标题\n用 `行内代码` 和 ```围栏``` 举例\n结尾反引号 ``';
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'thought', text: thought },
      { kind: 'text', blockId: 'answer', text: '# 正文标题仍然降级' },
    ]));
    const all = nodes(message);
    const content = all.find(node => node.element_id === flowElementId('text', 'thought#0'))!.content as string;
    // No fence wrapper any more; the thought keeps its own backticks and only headings are rewritten.
    expect(content).toBe('**标题**\n用 `行内代码` 和 ```围栏``` 举例\n结尾反引号 ``');
    const answer = all.find(node => node.element_id === flowElementId('text', 'answer'))!.content as string;
    expect(answer).toBe('**正文标题仍然降级**');
  });
  it('does not reuse an ID-less legacy turn as a mutable thinking detail source', () => {
    const { formatter, registerThinking } = fixture();
    const text = '缺少唯一turn时保留全文'.repeat(100);
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'legacy-shared', text },
    ], { turnId: undefined }));
    expect(registerThinking).not.toHaveBeenCalled();
    // Without a detail panel to fall back on, an uncapped body is the only lossless choice.
    expect(body(message, 'legacy-shared#0')).toBe(text);
    expect(JSON.stringify(message)).not.toContain('查看完整思考');
  });
  it('keeps terminal thoughts folded and gives each turn a separate detail identity', () => {
    const { formatter, retained } = fixture();
    const text = '思考'.repeat(500);
    const one = formatter.formatProgress('chat', progress([{ kind: 'thinking', blockId: 'thought', text }], { phase: 'completed' }));
    formatter.formatProgress('chat', progress([{ kind: 'thinking', blockId: 'thought', text }], { turnId: 'next-turn' }));
    expect(nodes(one).find(node => node.tag === 'collapsible_panel')!.expanded).toBe(false);
    expect(retained.size).toBe(2);
  });
});
