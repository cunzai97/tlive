import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyNativeCard, configureNativePrintConfig, createNativeCardState, ensureNativeCard, prepareNativeCard } from '../../server/channels/feishu/native-streaming.js';
import { DEFAULT_FEISHU_NATIVE_PRINT } from '../../shared/feishu-card-config.js';
import { planFeishuCards, type CardObject } from '../../server/channels/feishu/card-budget.js';
const budget = { maxBytes: 4000, maxElements: 160, maxTables: 4 };
const source = (text = '第一段'): CardObject => ({ schema: '2.0', config: { update_multi: true }, body: { elements: [
  { tag: 'collapsible_panel', element_id: 'thought', expanded: true,
    header: { title: { tag: 'plain_text', content: '思考' } },
    elements: [{ tag: 'markdown', element_id: 'text', content: text }] },
] } });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false; let result!: T; let error: unknown;
  promise.then((value) => { done = true; result = value; }, (value) => { done = true; error = value; });
  for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(120);
  expect(done).toBe(true); if (error) throw error; return result;
}
function fixture() {
  const calls: Array<{ at: number; kind: string; sequence?: number; uuid?: string }> = [];
  const record = (kind: string, request: any) => {
    calls.push({ kind, at: Date.now(), sequence: request.data.sequence, uuid: request.data.uuid });
    return { code: 0 };
  };
  const create = vi.fn(async (request) => { record('create', request); return { code: 0, data: { card_id: '1' } }; });
  const update = vi.fn(async (request) => record('update', request));
  const settings = vi.fn(async (request) => record('settings', request));
  const content = vi.fn(async (request) => record('content', request));
  const patch = vi.fn(async (request) => record('patch', request));
  const client = { cardkit: { v1: { card: { create, update, settings }, cardElement: { content, patch } } } } as unknown as Client;
  const state = createNativeCardState();
  const planned = (card: CardObject) => {
    const prepared = prepareNativeCard(card, ['text']);
    const plan = planFeishuCards(prepared.card, budget)[0];
    return { plan, ids: plan.elementIds!.text };
  };
  return { client, state, calls, create, update, settings, content, patch, planned };
}
describe('CardKit page protocol and identity', () => {
  it('maps source identities to actual post-pagination IDs and does not mutate source', () => {
    const card = source('中文😀'.repeat(900)); const before = JSON.stringify(card);
    const prepared = prepareNativeCard(card, ['text']);
    const plans = planFeishuCards(prepared.card, budget);
    expect(plans.length).toBeGreaterThan(1);
    for (const plan of plans) {
      const ids = plan.elementIds!.text;
      expect(ids).toHaveLength(1);
      expect(plan.content).toContain(`"element_id":"${ids[0]}"`);
      expect(ids[0]).not.toBe('text');
      expect(ids[0]).toMatch(/^[a-zA-Z0-9_]{1,20}$/);
    }
    expect(JSON.stringify(card)).toBe(before);
  });
  it('creates a text-empty shell, validates full targets and rate-limits all page operations', async () => {
    const f = fixture(); const { plan, ids } = f.planned(source());
    await settle(ensureNativeCard(f.client, f.state, plan.content, budget, ids));
    expect(JSON.parse(f.create.mock.calls[0][0].data.data).body.elements[0].elements[0].content).toBe('');
    await settle(applyNativeCard(f.client, f.state, plan.content, budget, ids, false));
    const next = f.planned(source('第一段，第二段'));
    await settle(applyNativeCard(f.client, f.state, next.plan.content, budget, next.ids, false));
    expect(f.content.mock.calls.map(([request]) => request.data.content)).toEqual(['第一段', '第一段，第二段']);
    expect(f.update).not.toHaveBeenCalled();
    for (let i = 1; i < f.calls.length; i++) expect(f.calls[i].at - f.calls[i - 1].at).toBeGreaterThanOrEqual(120);
    const operations = f.calls.filter((call) => call.sequence !== undefined);
    expect(operations.map((call) => call.sequence)).toEqual([1, 2]);
    expect(new Set(operations.map((call) => call.uuid)).size).toBe(2);
    await expect(settle(applyNativeCard(f.client, f.state, JSON.stringify(source('x'.repeat(10000))), budget, ['text'], false))).rejects.toThrow('budget');
    expect(f.content).toHaveBeenCalledTimes(2);
  });
  it('updates collapse/status attributes locally and closes then reopens for a resumed block', async () => {
    const f = fixture(); const first = f.planned(source());
    await settle(ensureNativeCard(f.client, f.state, first.plan.content, budget, first.ids));
    await settle(applyNativeCard(f.client, f.state, first.plan.content, budget, first.ids, false));
    const completed = source(); completed.body.elements[0].expanded = false;
    const closed = f.planned(completed);
    await settle(applyNativeCard(f.client, f.state, closed.plan.content, budget, closed.ids, true));
    expect(f.patch).toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.state.streaming).toBe(false);
    const next = f.planned(source('第一段，恢复追加'));
    await settle(applyNativeCard(f.client, f.state, next.plan.content, budget, next.ids, false));
    expect(f.state.streaming).toBe(true);
    expect(f.settings.mock.calls.some(([request]) => JSON.parse(request.data.settings).config.streaming_mode === true)).toBe(true);
    expect(f.content.mock.calls.at(-1)![0].data.content).toBe('第一段，恢复追加');
  });
  it('renews platform streaming mode before its automatic timeout', async () => {
    const f = fixture(); const first = f.planned(source());
    await settle(ensureNativeCard(f.client, f.state, first.plan.content, budget, first.ids));
    await settle(applyNativeCard(f.client, f.state, first.plan.content, budget, first.ids, false));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    const next = f.planned(source('第一段，延续'));
    await settle(applyNativeCard(f.client, f.state, next.plan.content, budget, next.ids, false));
    expect(f.settings.mock.calls.some(([request]) => JSON.parse(request.data.settings).config.streaming_mode === true)).toBe(true);
    expect(f.state.streaming).toBe(true);
  });
  it('writes the configured print speed into the entity, which is the only knob Feishu animates from', () => {
    const client = {} as unknown as Client;
    expect(prepareNativeCard(source(), ['text'], client).card.config.streaming_config).toEqual({
      print_frequency_ms: { default: DEFAULT_FEISHU_NATIVE_PRINT.frequencyMs },
      print_step: { default: DEFAULT_FEISHU_NATIVE_PRINT.step },
      print_strategy: DEFAULT_FEISHU_NATIVE_PRINT.strategy,
    });
    configureNativePrintConfig(client, { strategy: 'fast', frequencyMs: 50, step: 60 });
    expect(prepareNativeCard(source(), ['text'], client).card.config.streaming_config).toEqual({
      print_frequency_ms: { default: 50 }, print_step: { default: 60 }, print_strategy: 'fast',
    });
    // Another client without a configured speed still gets the default, never the first one's numbers.
    expect(prepareNativeCard(source(), ['text'], {} as unknown as Client).card.config
      .streaming_config.print_step.default).toBe(DEFAULT_FEISHU_NATIVE_PRINT.step);
  });
});
