import { describe, expect, it, vi } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { estimatedTokenCount } from '../../server/channels/feishu/flow-blocks.js';
import { flowElementId } from '../../server/channels/feishu/tool-display.js';
import type { FeishuToolDetails } from '../../server/channels/feishu/tool-details.js';
import { FEISHU_THINKING_PREVIEW_TOKENS, thinkingTail } from '../../server/channels/feishu/thinking-preview.js';

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

describe('bounded display-only thinking suffix', () => {
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

describe('thinking preview formatting without hidden full-history JSON', () => {
  it('retains the full semantic block in details but serializes only its suffix', () => {
    const { formatter, retained } = fixture();
    const full = 'REMOVED_OLD_THOUGHT' + '旧'.repeat(5000) + '新'.repeat(300);
    const data = progress([{ kind: 'thinking', blockId: 'thought', text: full }], { renderedText: full });
    const original = structuredClone(data);
    const message = formatter.formatProgress('chat', data);
    const json = JSON.stringify(message);
    expect(json).not.toContain('REMOVED_OLD_THOUGHT');
    expect(json).not.toContain('旧'.repeat(100));
    expect(json).toContain('新'.repeat(300));
    expect(json).toContain('查看完整思考');
    expect(json).toContain('仅显示最近约 300 Token');
    expect(retained.get('turn:thought')!.text).toBe(full);
    expect(data).toEqual(original);
    expect(nodes(message).find(node => node.tag === 'collapsible_panel')!.expanded).toBe(true);
    expect(message.feishuSnapshot).toBe(true);
  });
  it('has one shared 300-token budget across historical and nested thought blocks', () => {
    const { formatter } = fixture();
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'old', text: '消失'.repeat(1500) },
      { kind: 'text', blockId: 'answer', text: '模型正文不裁剪'.repeat(700) },
      { kind: 'tool', toolId: 'one', toolName: 'Read', status: 'completed', toolResult: 'ok' },
      { kind: 'thinking', blockId: 'middle', text: '中'.repeat(40) },
      { kind: 'tool', toolId: 'two', toolName: 'Read', status: 'completed', toolResult: 'ok' },
      { kind: 'thinking', blockId: 'latest', text: '最'.repeat(270) },
    ]));
    const all = nodes(message);
    const thoughtText = ['old', 'middle', 'latest'].map(id => all.find(node => node.element_id === flowElementId('text', id))?.content ?? '');
    expect(thoughtText).toEqual(['', '中'.repeat(30), '最'.repeat(270)]);
    expect(estimatedTokenCount(thoughtText.join(''))).toBe(300);
    expect(JSON.stringify(message)).not.toContain('消失'.repeat(20));
    expect(JSON.stringify(message)).toContain('模型正文不裁剪'.repeat(700));
    expect(all.filter(node => node.tag === 'button' && node.text?.content === '查看完整思考')).toHaveLength(3);
  });
  it('keeps payload size bounded as one thinking block grows, and preserves button identity', () => {
    const { formatter } = fixture();
    const render = (text: string) => formatter.formatProgress('chat', progress([{ kind: 'thinking', blockId: 'thought', text }]));
    const first = render('旧'.repeat(400) + '尾'.repeat(300));
    const huge = render('旧'.repeat(30000) + '尾'.repeat(300));
    expect(JSON.stringify(huge)).toBe(JSON.stringify(first));
  });
  it('preserves full content when retention is unavailable rather than silently deleting history', () => {
    const full = '不能丢'.repeat(1000);
    const { formatter } = fixture(false);
    const json = JSON.stringify(formatter.formatProgress('chat', progress([{ kind: 'thinking', blockId: 'thought', text: full }])));
    expect(json).toContain(full);
    expect(json).not.toContain('查看完整思考');
  });
  it('redacts the full source before cutting through a long credential', () => {
    const { formatter } = fixture();
    const synthetic = 'sk-' + 'A'.repeat(2000);
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'thought', text: `旧思考 ${synthetic} 结尾` },
    ]));
    const json = JSON.stringify(message);
    expect(json).toContain('[REDACTED]');
    expect(json).not.toContain('A'.repeat(50));
  });
  it('does not reuse an ID-less legacy turn as a mutable thinking detail source', () => {
    const { formatter, registerThinking } = fixture();
    const text = '缺少唯一turn时保留全文'.repeat(100);
    const message = formatter.formatProgress('chat', progress([
      { kind: 'thinking', blockId: 'legacy-shared', text },
    ], { turnId: undefined }));
    expect(registerThinking).not.toHaveBeenCalled();
    expect(JSON.stringify(message)).toContain(text);
    expect(JSON.stringify(message)).toContain('完整思考详情暂不可用');
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
