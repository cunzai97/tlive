import type { Client } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import { configureFeishuCardBudget, fitsFeishuCard, planFeishuCards } from '../../server/channels/feishu/card-budget.js';
import { sendFeishuMessage, editFeishuMessage, getFeishuMessageIds } from '../../server/channels/feishu/sender.js';
import { FeishuToolDetails } from '../../server/channels/feishu/tool-details.js';
import { classifyDefaultError } from '../../server/channels/errors.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import type { ProgressData } from '../../shared/formatting/message-types.js';

function markdown(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(markdown);
  const node = value as Record<string, unknown>;
  return [
    ...(node.tag === 'markdown' && typeof node.content === 'string' ? [node.content] : []),
    ...Object.values(node).flatMap(markdown),
  ];
}
const card = (a: string, b: string) => ({ schema: '2.0', body: { elements: [
  { tag: 'markdown', element_id: 'a', content: a },
  { tag: 'markdown', element_id: 'b', content: b },
] } });

function sdkFixture() {
  const remote = new Map<string, string>();
  const uuids = new Map<string, string>();
  let index = 0;
  const create = vi.fn(async (request) => {
    let id = uuids.get(request.data.uuid);
    if (!id) { id = `m${++index}`; uuids.set(request.data.uuid, id); }
    remote.set(id, request.data.content);
    return { code: 0, data: { message_id: id } };
  });
  const patch = vi.fn(async (request) => { remote.set(request.path.message_id, request.data.content); return { code: 0 }; });
  const remove = vi.fn(async (request) => { remote.delete(request.path.message_id); return { code: 0 }; });
  const client = { im: { message: { create, reply: create, patch, delete: remove } } } as unknown as Client;
  const body = () => [...remote.values()].flatMap((value) => markdown(JSON.parse(value))).join('');
  return { client, create, patch, remove, remote, uuids, body };
}

describe('independent review continuation regressions', () => {
  it('replans only the affected suffix when earlier frozen content grows before a later block', () => {
    const a = 'A'.repeat(40000);
    const b = 'B'.repeat(40000);
    const before = planFeishuCards(card(a, b));
    const after = planFeishuCards(card(a + 'NEW', b), undefined, before);
    const output = after.flatMap((page) => markdown(JSON.parse(page.content))).join('');
    expect(output).toBe(a + 'NEW' + b);
    expect(after[0].content).toBe(before[0].content);
    expect(after.every((page) => fitsFeishuCard(page.content, page.budget))).toBe(true);
  });

  it('can lower the unsent tail budget after a confirmed first card without resending that root', async () => {
    const f = sdkFixture();
    configureFeishuCardBudget(f.client, { maxBytes: 4000 });
    const real = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(real).mockResolvedValueOnce({ code: 230025, msg: 'card size over limit' } as never);
    const text = '汉🐾'.repeat(4000);
    const result = await sendFeishuMessage(f.client, { chatId: 'chat', text, deliveryId: 'turn' }, classifyDefaultError);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('m1');
    expect(f.body()).toBe(text);
    const rootUuid = f.create.mock.calls[0][0].data.uuid;
    expect(f.create.mock.calls.filter(([request]) => request.data.uuid === rootUuid)).toHaveLength(1);
    expect(getFeishuMessageIds(f.client, result.messageId)).toEqual([...f.remote.keys()]);
    for (const [request] of f.create.mock.calls) expect(fitsFeishuCard(request.data.content, { maxBytes: 4000, maxElements: 160, maxTables: 4 })).toBe(true);
  });

  it('replans the failed historical slot when the platform rejects a metadata update', async () => {
    const f = sdkFixture();
    configureFeishuCardBudget(f.client, { maxBytes: 4000 });
    const text = '历史内容🐾'.repeat(1200);
    const { messageId } = await sendFeishuMessage(f.client, { chatId: 'chat', text }, classifyDefaultError);
    f.patch.mockResolvedValueOnce({ code: 230025, msg: 'card size over limit' } as never);
    await editFeishuMessage(f.client, messageId, {
      chatId: 'chat', text, feishuHeader: { template: 'green', title: '完成' },
    }, classifyDefaultError);
    expect(f.body()).toBe(text);
    expect([...f.remote.values()].every((value) => JSON.parse(value).header.title.content === '完成')).toBe(true);
    expect(getFeishuMessageIds(f.client, messageId)[0]).toBe(messageId);
  });

  it('preserves a trailing short text when a following tool reparents it into a group', () => {
    const formatter = new FeishuFormatter('zh');
    const tool = (id: string, input: string) => ({ kind: 'tool' as const, toolId: id, toolName: 'Read', status: 'completed' as const, toolInput: input, toolResult: 'hidden' });
    const input = 'FIRST_' + 'a'.repeat(2000) + '_FIRST_END';
    const gap = { kind: 'text' as const, blockId: 'gap', text: 'GAP_NARRATION' };
    const render = (timeline: ProgressData['timeline']) => ({ schema: '2.0', body: { elements: formatter.formatProgress('chat', {
      phase: 'executing', totalTools: 2, taskSummary: '', elapsedSeconds: 1, renderedText: '', todoItems: [], timeline, actionButtons: [],
    }).feishuElements } });
    const budget = { maxBytes: 1600, maxElements: 160, maxTables: 4 };
    const before = planFeishuCards(render([tool('r1', input), gap]), budget);
    const after = planFeishuCards(render([tool('r1', input), gap, tool('r2', 'SECOND_INPUT')]), budget, before);
    const output = after.flatMap((page) => markdown(JSON.parse(page.content))).join('');
    expect(output.match(/GAP_NARRATION/g)).toHaveLength(1);
    expect(output.indexOf('_FIRST_END')).toBeLessThan(output.indexOf('GAP_NARRATION'));
    expect(output.indexOf('GAP_NARRATION')).toBeLessThan(output.indexOf('SECOND_INPUT'));
  });

  it('reuses a detail open UUID after the platform sends the card but the response is lost', async () => {
    const f = sdkFixture();
    const details = new FeishuToolDetails({ cleanupIntervalMs: 100000 });
    const id = details.register('chat', {
      kind: 'tool', toolId: 'write1', toolName: 'write', status: 'completed', toolResult: 'ok',
      inputData: { path: 'example.ts', content: '快照' },
    })!;
    details.bind({ chatId: 'chat', flowDetailUserId: 'owner', replyToMessageId: 'source',
      feishuButtons: [{ label: '详情', callbackData: `flow_detail:open:${id}` }] }, ['main']);
    const message = { channelType: 'feishu' as const, chatId: 'chat', userId: 'owner', text: '', messageId: 'main', callbackData: `flow_detail:open:${id}` };
    const real = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (request) => {
      await real(request);
      throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    });
    try {
      expect(await details.handle(message, f.client, true)).toMatchObject({ toast: { type: 'error' } });
      expect(f.remote.size).toBe(1);
      expect(await details.handle(message, f.client, true)).toMatchObject({ toast: { type: 'success' } });
      expect(f.remote.size).toBe(1);
      expect(f.create.mock.calls[1][0].data.uuid).toBe(f.create.mock.calls[0][0].data.uuid);
      expect(await details.handle({ ...message, messageId: 'm1', callbackData: `flow_detail:close:${id}` }, f.client, true)).toMatchObject({ toast: { type: 'success' } });
      expect(await details.handle(message, f.client, true)).toMatchObject({ toast: { type: 'success' } });
      expect(f.create.mock.calls[2][0].data.uuid).not.toBe(f.create.mock.calls[0][0].data.uuid);
      expect(f.remote.size).toBe(1);
    } finally { details.dispose(); }
  });
});
