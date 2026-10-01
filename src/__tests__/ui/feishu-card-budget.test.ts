import { describe, expect, it } from 'vitest';
import {
  assertFeishuCardBudget,
  checkedFeishuResult,
  configureFeishuCardBudget,
  DEFAULT_FEISHU_CARD_BUDGET,
  fitsFeishuCard,
  getFeishuCardBudget,
  isFeishuCardLimitError,
  lowerFeishuCardBudget,
  measureFeishuCard,
  planFeishuCards,
  resolveFeishuCardBudget,
  type CardObject,
  type PlannedFeishuCard,
} from '../../server/channels/feishu/card-budget.js';

const budget = { maxBytes: 1100, maxElements: 160, maxTables: 4 };
const card = (elements: CardObject[]): CardObject => ({
  schema: '2.0',
  header: { title: { tag: 'plain_text', content: '测试' } },
  body: { elements },
});
const md = (content: string, element_id = 'body'): CardObject => ({ tag: 'markdown', content, element_id });
function verify(plans: PlannedFeishuCard[], source: string): void {
  const slices = plans.flatMap((plan) => plan.slices).filter((slice) => slice.text === source);
  let offset = 0;
  for (const slice of slices) {
    expect(slice.start).toBe(offset);
    expect(slice.end).toBeGreaterThan(slice.start);
    expect(/[\uDC00-\uDFFF]/.test(source[slice.start] ?? '')).toBe(false);
    offset = slice.end;
  }
  expect(offset).toBe(source.length);
  expect(slices.map((slice) => source.slice(slice.start, slice.end)).join('')).toBe(source);
  for (const plan of plans) {
    expect(fitsFeishuCard(plan.content, budget)).toBe(true);
    const size = measureFeishuCard(plan.content);
    expect(size.bytes).toBeLessThanOrEqual(budget.maxBytes);
    expect(size.requestBytes).toBeLessThanOrEqual(budget.maxBytes);
  }
}
function nodes(value: unknown): CardObject[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const object = value as CardObject;
  return [object, ...Object.values(object).flatMap(nodes)];
}

describe('Feishu final-card capacity planner', () => {
  it('uses conservative defaults and clamps direct and configured hard limits', () => {
    expect(DEFAULT_FEISHU_CARD_BUDGET).toEqual({ maxBytes: 24000, maxElements: 160, maxTables: 4 });
    const client = {};
    configureFeishuCardBudget(client, { maxBytes: 999999, maxElements: 999999, maxTables: 999 });
    expect(getFeishuCardBudget(client)).toEqual({ maxBytes: 28000, maxElements: 190, maxTables: 4 });
    expect(() => resolveFeishuCardBudget({ maxBytes: 0 })).toThrow();
    expect(() => resolveFeishuCardBudget({ maxElements: 1.5 })).toThrow();
    expect(fitsFeishuCard(card([md('中'.repeat(11000))]), { maxBytes: 999999, maxElements: 999, maxTables: 999 })).toBe(false);
    expect(lowerFeishuCardBudget({ maxBytes: 1000, maxElements: 100, maxTables: 4 })).toEqual({ maxBytes: 750, maxElements: 75, maxTables: 3 });
  });

  it('counts every recursive tag including titles, text and button children', () => {
    const value = card([{ tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '组' } }, elements: [
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'div', text: { tag: 'plain_text', content: '内容' } }] }] },
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看' } }] },
    ] }]);
    expect(measureFeishuCard(value).elements).toBe(10);
    expect(fitsFeishuCard(value, { ...budget, maxElements: 9 })).toBe(false);
  });

  it('measures the full JSON and escaped outer card_json request', () => {
    const value = card([md('\\\"\n中文😀'.repeat(200))]);
    const serialized = JSON.stringify(value);
    const size = measureFeishuCard(value);
    expect(size.bytes).toBe(Buffer.byteLength(serialized));
    expect(size.requestBytes).toBe(Buffer.byteLength(JSON.stringify({ type: 'card_json', data: serialized })));
    expect(size.requestBytes).toBeGreaterThan(size.bytes);
    expect(measureFeishuCard(serialized)).toEqual(size);
    expect(() => assertFeishuCardBudget(value, budget)).toThrow();
  });

  it.each(['单段中文😀🚀'.repeat(300), '\\"\n'.repeat(800)])('preserves unbroken Unicode and escaped text offsets', (source) => {
    const plans = planFeishuCards(card([md(source)]), budget);
    expect(plans.length).toBeGreaterThan(1);
    verify(plans, source);
    for (const plan of plans) expect(plan.content).not.toMatch(/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/);
  });

  it('splits div.text.content while preserving its plain_text tag', () => {
    const source = '普通中文😀'.repeat(500);
    const plans = planFeishuCards(card([{ tag: 'div', text: { tag: 'plain_text', content: source } }]), budget);
    verify(plans, source);
    expect(plans.map((plan) => JSON.parse(plan.content).body.elements[0].text.content).join('')).toBe(source);
  });

  it('supports legacy top-level elements and lark_md text', () => {
    const source = '正文😀'.repeat(500);
    const plans = planFeishuCards({ elements: [{ tag: 'div', text: { tag: 'lark_md', content: source } }] }, budget);
    verify(plans, source);
    expect(JSON.parse(plans[0].content).elements[0].text.tag).toBe('lark_md');
  });

  it('preserves nested panels, columns and atomic button actions', () => {
    const source = '嵌套😀'.repeat(500);
    const value = card([{ tag: 'collapsible_panel', expanded: true, header: { title: { tag: 'plain_text', content: '工具' } }, elements: [
      { tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '内部' } }, elements: [
        { tag: 'column_set', columns: [{ tag: 'column', elements: [md(source)] }] },
      ] },
      { tag: 'action', actions: [{ tag: 'button', value: { snapshot: 'keep-me' }, text: { tag: 'plain_text', content: '详情' } }] },
    ] }]);
    const plans = planFeishuCards(value, budget);
    verify(plans, source);
    const buttons = plans.flatMap((plan) => nodes(JSON.parse(plan.content))).filter((node) => node.tag === 'button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].value).toEqual({ snapshot: 'keep-me' });
    expect(plans[0].content).toContain('"expanded":false');
    expect(plans.at(-1)!.content).toContain('工具（续）');
  });

  it.each(['```ts\n', '~~~~python\n'])('closes and reopens code fences without losing huge code lines', (opening) => {
    const marker = opening.startsWith('`') ? '```' : '~~~~';
    const source = `${opening}${'const 中文 = "😀";'.repeat(400)}\n${marker}\n尾声`;
    const plans = planFeishuCards(card([md(source)]), budget);
    verify(plans, source);
    for (const plan of plans) {
      const content = JSON.parse(plan.content).body.elements[0].content as string;
      expect([...content.matchAll(/^(`{3,}|~{3,})/gm)].length % 2).toBe(0);
    }
  });

  it('repeats table headers and preserves row whitespace and source offsets', () => {
    const header = '| 姓名 | 数据 |\n| --- | --- |\n';
    const source = header + Array.from({ length: 65 }, (_, i) => `| 行${i} |  中文😀${'x'.repeat(25)}  |\n`).join('');
    const plans = planFeishuCards(card([md(source)]), budget);
    verify(plans, source);
    for (const plan of plans) expect(JSON.parse(plan.content).body.elements[0].content).toContain(header.trimEnd());
    expect(plans.flatMap((plan) => nodes(JSON.parse(plan.content))).map((node) => node.content ?? '').join('')).toContain('  |');
  });

  it('keeps oversized table cells accessible with repeated headers', () => {
    const source = '| 项目 | 数据 |\n| --- | --- |\n| 超长 | ' + '中文😀'.repeat(700) + ' |\n';
    const plans = planFeishuCards(card([md(source)]), budget);
    verify(plans, source);
    for (const plan of plans) expect(JSON.parse(plan.content).body.elements[0].content).toContain('| 项目 | 数据 |');
  });

  it('enforces table-count and recursive component budgets', () => {
    const source = Array.from({ length: 12 }, (_, i) => `| H${i} |\n| --- |\n| V${i} |\n\n`).join('');
    const plans = planFeishuCards(card([md(source)]), { ...budget, maxTables: 1 });
    for (const plan of plans) expect(measureFeishuCard(plan.content).tables).toBeLessThanOrEqual(1);
    const many = planFeishuCards(card(Array.from({ length: 15 }, (_, i) => ({ tag: 'div', text: { tag: 'plain_text', content: String(i) } }))), { ...budget, maxElements: 5 });
    for (const plan of many) expect(measureFeishuCard(plan.content).elements).toBeLessThanOrEqual(5);
    expect(many.flatMap((plan) => plan.slices)).toHaveLength(15);
  });

  it('retains sealed source ownership on append and updates running status to final', () => {
    const initial = '历史😀'.repeat(600);
    const first = planFeishuCards(card([md('运行中', 'status'), md(initial, 'answer')]), budget);
    const source = initial + '追加中文🚀'.repeat(300);
    const next = planFeishuCards(card([md('已完成', 'status'), md(source, 'answer')]), budget, first);
    verify(next, source);
    first.filter((plan) => plan.sealed).forEach((plan, index) => {
      const original = plan.slices.map(({ key, start, end }) => ({ key, start, end }));
      expect(next[index].slices.map(({ key, start, end }) => ({ key, start, end }))).toEqual(original);
    });
    expect(next[0].content).toContain('已完成');
    expect(next.map((plan) => plan.content).join('')).not.toContain('运行中');
    const again = planFeishuCards(card([md('已完成', 'status'), md(source, 'answer')]), budget, next);
    expect(again).toEqual(next);
  });

  it('keeps all five ordinary tables materialized across a four-table boundary', () => {
    const source = Array.from({ length: 5 }, (_, i) => `| H${i} |\n| --- |\n| V${i} |\n\n`).join('');
    const plans = planFeishuCards(card([md(source)]));
    expect(plans.map((plan) => measureFeishuCard(plan.content).tables)).toEqual([4, 1]);
    expect(plans.flatMap((plan) => plan.slices).map((slice) => source.slice(slice.start, slice.end)).join('')).toBe(source);
  });

  it('reserves sealed header/footer growth without moving or corrupting source ranges', () => {
    const source = '中文🐾🙂'.repeat(700);
    const value = card([md(source)]);
    value.header.title.content = '生成中';
    const first = planFeishuCards(value, budget);
    value.header.title.content = '已完成：所有工作完成';
    value.config = { streaming_mode: false, summary: { content: '完整收尾' } };
    const next = planFeishuCards(value, budget, first);
    verify(next, source);
    first.filter((plan) => plan.sealed).forEach((plan, index) => expect(next[index].slices).toEqual(plan.slices));
    expect(next.every((plan) => plan.content.includes('已完成：所有工作完成'))).toBe(true);
  });

  it('generates <=20-character IDs unique across every tagged/header object per card', () => {
    const value = card([md('A', 'same'.repeat(30)), md('B', 'same'.repeat(30)), { tag: 'div', element_id: 'same', text: { tag: 'plain_text', content: 'C', element_id: 'same' } }]);
    value.header.title.element_id = 'same';
    const plans = planFeishuCards(value, budget);
    expect(plans[0].slices).toHaveLength(3);
    for (const plan of plans) {
      const ids = nodes(JSON.parse(plan.content)).map((node) => node.element_id).filter((id): id is string => typeof id === 'string');
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id.length).toBeLessThanOrEqual(20);
    }
    expect(value.header.title.element_id).toBe('same');
  });

  it('checks fulfilled SDK errors and only classifies actual limit failures', () => {
    expect(checkedFeishuResult({ code: '0' })).toEqual({ code: '0' });
    expect(() => checkedFeishuResult({ code: 230025, msg: 'too large' })).toThrow('too large');
    expect(isFeishuCardLimitError({ code: 230025 })).toBe(true);
    expect(isFeishuCardLimitError({ code: 230099, msg: 'invalid syntax' })).toBe(false);
    expect(isFeishuCardLimitError({ code: 230099, msg: 'card table number over limit' })).toBe(true);
  });
});
