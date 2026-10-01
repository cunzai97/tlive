import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyDefaultError } from '../../server/channels/errors.js';
import {
  configureFeishuCardBudget,
  getFeishuCardBudget,
  measureFeishuCard,
} from '../../server/channels/feishu/card-budget.js';
import {
  editFeishuMessage,
  getFeishuMessageIds,
  sendFeishuMessage,
  startFeishuThreadFromMessage,
  startFeishuThreadWithTitle,
} from '../../server/channels/feishu/sender.js';
import type { FeishuRenderedMessage } from '../../server/channels/feishu/types.js';

interface Request {
  data: { content: string; msg_type?: string; uuid?: string; [key: string]: unknown };
  path?: { message_id: string };
  params?: { receive_id_type: string };
}

function sdk() {
  let sequence = 0;
  const remote = new Map<string, string>();
  const create = vi.fn(async (request: Request) => {
    const id = `message-${++sequence}`;
    remote.set(id, request.data.content);
    return { code: 0, data: { message_id: id, thread_id: 'thread-1' } };
  });
  const reply = vi.fn(async (request: Request) => create(request));
  const patch = vi.fn(async (request: Request) => {
    remote.set(request.path!.message_id, request.data.content);
    return { code: 0 };
  });
  const remove = vi.fn(async ({ path }: { path: { message_id: string } }) => {
    remote.delete(path.message_id);
    return { code: 0 };
  });
  const pin = vi.fn(async () => ({ code: 0 }));
  const client = { im: { message: { create, reply, patch, delete: remove }, pin: { create: pin } } } as unknown as Client;
  return { client, create, reply, patch, remove, pin, remote };
}

function markdowns(content: string): string[] {
  const result: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (node.tag === 'markdown') result.push(String(node.content));
    Object.values(node).forEach(visit);
  };
  visit(JSON.parse(content));
  return result;
}

function assertRequestsFit(mock: ReturnType<typeof sdk>, maxBytes?: number, maxElements?: number) {
  const budget = getFeishuCardBudget(mock.client);
  const requests = [...mock.create.mock.calls, ...mock.patch.mock.calls].map(([request]) => request);
  for (const request of requests) {
    if (request.data.msg_type && request.data.msg_type !== 'interactive') continue;
    const measured = measureFeishuCard(request.data.content);
    expect(Math.max(measured.bytes, measured.requestBytes)).toBeLessThanOrEqual(maxBytes ?? budget.maxBytes);
    expect(measured.elements).toBeLessThanOrEqual(maxElements ?? budget.maxElements);
    expect(measured.tables).toBeLessThanOrEqual(budget.maxTables);
    expect(request.data.content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  }
}

const send = (mock: ReturnType<typeof sdk>, message: FeishuRenderedMessage) =>
  sendFeishuMessage(mock.client, message, classifyDefaultError);

afterEach(() => vi.useRealTimers());

describe('Feishu sender final SDK card payloads', () => {
  it.each([false, true])('sends and edits full Unicode content (structured=%s)', async (structured) => {
    const mock = sdk();
    const text = '汉字😀\\\"'.repeat(6500);
    const message: FeishuRenderedMessage = { chatId: 'chat', feishuHeader: { template: 'blue', title: '标题' },
      ...(structured ? { feishuElements: [{ tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '工具' } }, elements: [{ tag: 'markdown', content: text }] }] } : { text }) };
    const result = await send(mock, message);
    expect(mock.create.mock.calls.length).toBeGreaterThan(1);
    expect([...mock.remote.values()].flatMap(markdowns).join('')).toBe(text);
    expect(getFeishuMessageIds(mock.client, result.messageId)).toEqual([...mock.remote.keys()]);
    await editFeishuMessage(mock.client, result.messageId, message);
    expect(mock.patch).not.toHaveBeenCalled();
    const grown = structured ? { ...message, feishuElements: [{ tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '工具' } }, elements: [{ tag: 'markdown', content: text + '后续😀'.repeat(7000) }] }] } : { ...message, text: text + '后续😀'.repeat(7000) };
    const prefix = [...mock.remote.entries()].slice(0, -1);
    await editFeishuMessage(mock.client, result.messageId, grown);
    for (const [id, content] of prefix) expect(mock.remote.get(id)).toBe(content);
    expect([...mock.remote.values()].flatMap(markdowns).join('')).toBe(text + '后续😀'.repeat(7000));
    assertRequestsFit(mock);
  });

  it('budgets nested components, headers and buttons at a configurable limit', async () => {
    const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 4000, maxElements: 12 });
    const message = { chatId: 'chat', feishuHeader: { template: 'blue', title: '标题' },
      feishuElements: Array.from({ length: 45 }, (_, index) => ({ tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: `块${index}` } }, elements: [{ tag: 'markdown', content: `内容${index}😀` }] })),
      buttons: [{ label: '查看', callbackData: 'details:test' }] };
    const result = await send(mock, message);
    expect(mock.create.mock.calls.length).toBeGreaterThan(1);
    for (let index = 0; index < 45; index++) expect([...mock.remote.values()].flatMap(markdowns).join('')).toContain(`内容${index}😀`);
    await editFeishuMessage(mock.client, result.messageId, { ...message, buttons: [{ label: '关闭', callbackData: 'close:test' }] });
    assertRequestsFit(mock, 4000, 12);
  });

  it.each(['from-message', 'with-title'])('budgets every startThread card (%s)', async (kind) => {
    const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 2500 });
    const common = { chatId: 'chat', text: '话题😀'.repeat(2500), autoPinTopics: true, classifyError: classifyDefaultError };
    const result = kind === 'from-message'
      ? await startFeishuThreadFromMessage(mock.client, { ...common, messageId: 'parent' })
      : await startFeishuThreadWithTitle(mock.client, { ...common, title: '话题标题' });
    expect(result?.threadId).toBe('thread-1');
    expect(mock.reply.mock.calls.length).toBeGreaterThan(1);
    expect(mock.pin).toHaveBeenCalledOnce();
    for (const [request] of mock.reply.mock.calls) expect(request.data.reply_in_thread).toBe(true);
    assertRequestsFit(mock, 2500);
    expect(getFeishuMessageIds(mock.client, result!.messageId).length).toBe(mock.reply.mock.calls.length);
    if (kind === 'with-title') expect(getFeishuMessageIds(mock.client, result!.rootMessageId!)).toEqual([...mock.remote.keys()]);
  });

  it.each([230099, 230020])('rejects fulfilled SDK code %s without format retries', async (code) => {
    const mock = sdk();
    mock.create.mockResolvedValue({ code, msg: 'invalid card syntax' } as never);
    await expect(send(mock, { chatId: 'chat', text: 'hello' })).rejects.toThrow('invalid card syntax');
    expect(mock.create).toHaveBeenCalledOnce();
  });

  it('rejects fulfilled patch errors and never seals the failed edit', async () => {
    const mock = sdk();
    const result = await send(mock, { chatId: 'chat', text: 'old' });
    mock.patch.mockResolvedValueOnce({ code: 230099, msg: 'invalid syntax' } as never);
    await expect(editFeishuMessage(mock.client, result.messageId, { chatId: 'chat', text: 'new' })).rejects.toThrow('invalid syntax');
    await editFeishuMessage(mock.client, result.messageId, { chatId: 'chat', text: 'new' });
    expect(mock.patch).toHaveBeenCalledTimes(2);
    expect(markdowns(mock.remote.get(result.messageId)!)).toEqual(['new']);
  });

  it('lowers platform limits at most twice, preserving the failed page uuid', async () => {
    const mock = sdk();
    mock.create.mockResolvedValue({ code: 230025, msg: 'card too large' } as never);
    await expect(send(mock, { chatId: 'chat', text: '汉😀'.repeat(5500) })).rejects.toThrow('card too large');
    expect(mock.create).toHaveBeenCalledTimes(3);
    const requests = mock.create.mock.calls.map(([request]) => request);
    expect(new Set(requests.map((request) => request.data.uuid)).size).toBe(1);
    const sizes = requests.map((request) => measureFeishuCard(request.data.content).requestBytes);
    expect(sizes[1]).toBeLessThan(sizes[0]);
    expect(sizes[2]).toBeLessThan(sizes[1]);
    assertRequestsFit(mock);
  });

  it('retains partial successes and retries a different object with deliveryId without duplicating root', async () => {
    const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 1800 });
    const normal = mock.create.getMockImplementation()!;
    let count = 0;
    mock.create.mockImplementation(async (request) => {
      if (++count === 3) throw new Error('network lost');
      return normal(request);
    });
    const message = { chatId: 'chat', text: '重试😀'.repeat(2200), deliveryId: 'turn:1' };
    await expect(send(mock, message)).rejects.toThrow('network lost');
    expect(getFeishuMessageIds(mock.client, 'message-1')).toEqual(['message-1', 'message-2']);
    const failedUuid = mock.create.mock.calls[2][0].data.uuid;
    const prefix = [...mock.remote.entries()];
    const result = await send(mock, { ...message });
    expect(result.messageId).toBe('message-1');
    expect(mock.create.mock.calls[3][0].data.uuid).toBe(failedUuid);
    expect(mock.patch).not.toHaveBeenCalled();
    for (const [id, content] of prefix) expect(mock.remote.get(id)).toBe(content);
    expect([...mock.remote.values()].flatMap(markdowns).join('')).toBe(message.text);
    const calls = mock.create.mock.calls.length;
    await send(mock, { ...message });
    expect(mock.create).toHaveBeenCalledTimes(calls);
    expect(getFeishuMessageIds(mock.client, result.messageId)).toEqual([...mock.remote.keys()]);
  });

  it('serializes concurrent retry objects with the same logical delivery', async () => {
    const mock = sdk();
    await Promise.all(Array.from({ length: 4 }, () => send(mock, { chatId: 'chat', text: 'one', deliveryId: 'same' })));
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.patch).not.toHaveBeenCalled();
  });

  it('keeps reply routing and missing-target fallbacks with identical uuid', async () => {
    const mock = sdk();
    mock.reply.mockResolvedValueOnce({ code: 230071, msg: 'thread unsupported' } as never);
    mock.create.mockResolvedValueOnce({ code: 230011, msg: 'missing parent' } as never);
    await send(mock, { chatId: 'user', receiveIdType: 'open_id', text: 'reply', replyToMessageId: 'parent', replyInThread: true });
    expect(mock.reply.mock.calls[0][0].path?.message_id).toBe('parent');
    expect(mock.create.mock.calls[0][0].params?.receive_id_type).toBe('open_id');
    expect(mock.create.mock.calls[0][0].data.root_id).toBe('parent');
    expect(mock.create.mock.calls[1][0].data.root_id).toBeUndefined();
    expect(new Set([...mock.create.mock.calls, ...mock.reply.mock.calls].map(([request]) => request.data.uuid)).size).toBe(1);
  });

  it('does not fallback when starting an unsupported thread', async () => {
    const mock = sdk();
    mock.reply.mockResolvedValueOnce({ code: 230071, msg: 'unsupported' } as never);
    expect(await startFeishuThreadFromMessage(mock.client, { chatId: 'chat', messageId: 'parent', text: 'hello', autoPinTopics: false, classifyError: classifyDefaultError })).toBeNull();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('expires idle deliveryId entries rather than retaining every logical send forever', async () => {
    vi.useFakeTimers();
    const mock = sdk();
    await send(mock, { chatId: 'chat', text: 'one', deliveryId: 'expired' });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await send(mock, { chatId: 'chat', text: 'one', deliveryId: 'expired' });
    expect(mock.create).toHaveBeenCalledTimes(2);
  });

  it('protects an active send and bounds completed delivery entries during cache churn', async () => {
    const mock = sdk();
    const normal = mock.create.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mock.create.mockImplementation(async (request) => {
      if (request.data.receive_id === 'active') await blocked;
      return normal(request);
    });
    const active = send(mock, { chatId: 'active', text: 'one', deliveryId: 'active-turn' });
    await Promise.resolve();
    for (let index = 0; index < 270; index++) await send(mock, { chatId: 'chat', text: 'other', deliveryId: `other-${index}` });
    const retry = send(mock, { chatId: 'active', text: 'one', deliveryId: 'active-turn' });
    release();
    expect((await active).messageId).toBe((await retry).messageId);
    expect(mock.create.mock.calls.filter(([request]) => request.data.receive_id === 'active')).toHaveLength(1);
    const count = mock.create.mock.calls.length;
    await send(mock, { chatId: 'chat', text: 'other', deliveryId: 'other-0' });
    expect(mock.create).toHaveBeenCalledTimes(count + 1);
  });

  it('prefers preserving a failed partial delivery over completed cache entries', async () => {
    const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 1800 });
    const normal = mock.create.getMockImplementation()!;
    let attempts = 0;
    mock.create.mockImplementation(async (request) => {
      if (request.data.receive_id === 'partial' && ++attempts === 2) throw new Error('lost overflow');
      return normal(request);
    });
    const message = { chatId: 'partial', text: '汉😀'.repeat(900), deliveryId: 'partial-turn' };
    await expect(send(mock, message)).rejects.toThrow('lost overflow');
    const uuid = mock.create.mock.calls[1][0].data.uuid;
    for (let index = 0; index < 270; index++) await send(mock, { chatId: 'chat', text: 'other', deliveryId: `finished-${index}` });
    expect(getFeishuMessageIds(mock.client, 'message-1')).toEqual(['message-1']);
    const result = await send(mock, { ...message });
    expect(result.messageId).toBe('message-1');
    const partialRequests = mock.create.mock.calls.filter(([request]) => request.data.receive_id === 'partial');
    expect(partialRequests[2][0].data.uuid).toBe(uuid);
    expect(mock.patch).not.toHaveBeenCalled();
  });

  it('retains stale successful overflow IDs when fulfilled delete fails, then retries cleanup', async () => {
    const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 1800 });
    const result = await send(mock, { chatId: 'chat', text: '汉😀'.repeat(1200) });
    const ids = getFeishuMessageIds(mock.client, result.messageId);
    mock.remove.mockResolvedValueOnce({ code: 230020, msg: 'delete throttled' } as never);
    await expect(editFeishuMessage(mock.client, result.messageId, { chatId: 'chat', text: 'short' })).rejects.toThrow('delete throttled');
    expect(getFeishuMessageIds(mock.client, result.messageId)).toEqual(ids);
    await editFeishuMessage(mock.client, result.messageId, { chatId: 'chat', text: 'short' });
    expect(getFeishuMessageIds(mock.client, result.messageId)).toEqual([result.messageId]);
    expect([...mock.remote.keys()]).toEqual([result.messageId]);
  });

  it('replans a nested platform table-limit error but not ordinary 230099 syntax', async () => {
    const mock = sdk();
    mock.create.mockRejectedValueOnce({ response: { data: { code: 230099, msg: 'card table number over limit' } } });
    const result = await send(mock, { chatId: 'chat', text: '汉😀'.repeat(5500) });
    expect(result.success).toBe(true);
    expect(mock.create.mock.calls[0][0].data.uuid).toBe(mock.create.mock.calls[1][0].data.uuid);
    expect(measureFeishuCard(mock.create.mock.calls[1][0].data.content).requestBytes).toBeLessThan(measureFeishuCard(mock.create.mock.calls[0][0].data.content).requestBytes);
    assertRequestsFit(mock);
  });
});
