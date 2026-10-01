import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureFeishuCardBudget,
  measureFeishuCard,
} from '../../server/channels/feishu/card-budget.js';
import { feishuCardActionToInbound } from '../../server/channels/feishu/events.js';
import {
  FeishuToolDetails,
  type FeishuToolDetailsOptions,
} from '../../server/channels/feishu/tool-details.js';
import type { FeishuRenderedMessage } from '../../server/channels/feishu/types.js';
import type { InboundMessage } from '../../server/channels/types.js';
import { redactSensitiveContent } from '../../shared/utils/content-filter.js';

interface Request {
  path?: { message_id?: string };
  data: { content: string; uuid?: string; reply_in_thread?: boolean; root_id?: string };
}
interface Card {
  header: { title: { content: string } };
  body: { elements: Array<{ text?: { tag: string; content: string } }> };
}
const instances: FeishuToolDetails[] = [];
afterEach(() => {
  for (const details of instances.splice(0)) details.dispose();
});
function store(options: FeishuToolDetailsOptions = {}) {
  const details = new FeishuToolDetails({ cleanupIntervalMs: 0, ...options });
  instances.push(details);
  return details;
}
function sdk() {
  let sequence = 0;
  const remote = new Map<string, string>([['source', 'MAIN_CARD_UNCHANGED']]);
  const uuids = new Map<string, string>();
  const send = async (request: Request) => {
    let id = request.data.uuid && uuids.get(request.data.uuid);
    if (!id) {
      id = `detail-${++sequence}`;
      if (request.data.uuid) uuids.set(request.data.uuid, id);
    }
    remote.set(id, request.data.content);
    return { code: 0, data: { message_id: id, thread_id: 'thread' } };
  };
  const reply = vi.fn(send);
  const create = vi.fn(send);
  const patch = vi.fn(async (request: Request) => {
    remote.set(request.path!.message_id!, request.data.content);
    return { code: 0 };
  });
  const del = vi.fn(async (request: { path: { message_id: string } }) => {
    remote.delete(request.path.message_id);
    return { code: 0 };
  });
  const client = { im: { message: { reply, create, patch, delete: del } } } as unknown as Client;
  return { client, reply, create, patch, del, remote, uuids };
}
function register(details: FeishuToolDetails, text: string, thinkingId = 'thinking-1') {
  return details.registerThinking('chat', { thinkingId, text, status: 'running' });
}
function bind(
  details: FeishuToolDetails,
  id: string,
  overrides: Partial<FeishuRenderedMessage> = {},
  sources = ['source'],
) {
  details.bind({
    chatId: 'chat', threadId: 'thread', replyToMessageId: 'root', replyInThread: true,
    flowDetailUserId: 'owner',
    feishuButtons: [{ label: '查看完整思考', callbackData: `flow_detail:open:${id}` }],
    ...overrides,
  }, sources);
}
function inbound(callbackData: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner', text: '',
    messageId: 'source', callbackData, ...overrides,
  };
}
function open(
  details: FeishuToolDetails,
  id: string,
  client: Client,
  overrides: Partial<InboundMessage> = {},
) {
  return details.handle(inbound(`flow_detail:open:${id}`, overrides), client, true);
}
function action(
  details: FeishuToolDetails,
  id: string,
  verb: string,
  client: Client,
  messageId = 'detail-1',
) {
  return details.handle(inbound(`flow_detail:${verb}:${id}`, { messageId }), client, true);
}
function page(
  details: FeishuToolDetails,
  id: string,
  n: number,
  client: Client,
  messageId = 'detail-1',
) {
  return details.handle(inbound(`flow_detail:page:${id}:${n}`, { messageId }), client, true);
}
function card(content: string): Card { return JSON.parse(content) as Card; }
function body(content: string): string { return card(content).body.elements[1].text!.content; }
function total(content: string): number {
  return Number(/第 \d+ \/ (\d+) 页/.exec(card(content).body.elements[0].text!.content)![1]);
}
function responseType(response: Record<string, unknown> | undefined) {
  return (response?.toast as { type?: string } | undefined)?.type;
}
async function readPages(
  details: FeishuToolDetails,
  id: string,
  mock: ReturnType<typeof sdk>,
  messageId = 'detail-1',
) {
  expect(responseType(await page(details, id, 0, mock.client, messageId))).toBe('success');
  const first = mock.remote.get(messageId)!;
  const count = total(first);
  const contents = [first];
  for (let n = 1; n < count; n++) {
    expect(responseType(await page(details, id, n, mock.client, messageId))).toBe('success');
    contents.push(mock.remote.get(messageId)!);
  }
  return { text: contents.map(body).join(''), contents, count };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('Feishu thinking details live sources and frozen browsing', () => {
  it('registers running/unspecified thinking with one stable ID and only the latest redacted source', async () => {
    const details = store(); const mock = sdk();
    const id = register(details, '')!;
    const base = details.stats.bytes;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (let n = 1; n <= 80; n++) {
      const text = '增长😀'.repeat(n);
      expect(register(details, text)).toBe(id);
      expect(details.stats).toEqual({ entries: 1, bytes: base + Buffer.byteLength(text, 'utf8') });
    }
    const text = '\u001b[31m最新全文\u001b[0m API_TOKEN=synthetic-test-value-1234';
    expect(details.registerThinking('chat', { thinkingId: 'thinking-1', text })).toBe(id);
    expect(details.stats.bytes).toBe(base + Buffer.byteLength(redactSensitiveContent(text), 'utf8'));
    bind(details, id);
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(body(mock.remote.get('detail-1')!)).toBe(redactSensitiveContent(text));
    expect(mock.remote.get('detail-1')).not.toContain('synthetic-test-value');
    expect(mock.remote.get('detail-1')).not.toContain('增长');
    expect(register(details, '最终', 'thinking-2')).not.toBe(id);
    expect(details.registerThinking('other-chat', { thinkingId: 'thinking-1', text: '另一个聊天' })).not.toBe(id);
  });

  it('rejects malformed identifiers and disposed stores without allocating entries', () => {
    const details = store();
    for (const [chatId, thinkingId] of [['', 'x'], ['chat', ''], ['中'.repeat(180), 'x'], ['chat', 'x'.repeat(513)]]) {
      expect(details.registerThinking(chatId, { thinkingId, text: '内容', status: 'running' })).toBeUndefined();
    }
    expect(details.registerThinking('chat', { thinkingId: 'x', text: undefined as unknown as string })).toBeUndefined();
    expect(details.stats).toEqual({ entries: 0, bytes: 0 });
    details.dispose();
    expect(register(details, '内容')).toBeUndefined();
  });

  it('paginates all literal Unicode thinking at the actual low client budget, one physical detail message', async () => {
    const details = store(); const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 3200, maxElements: 40, maxTables: 1 });
    const text = '中文😀🐾 \\"<b>原文</b>\r\n```ts\nconst a = "x";\n```\n'.repeat(220);
    const id = register(details, text)!; bind(details, id);
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    const result = await readPages(details, id, mock);
    expect(result.text).toBe(text);
    expect(result.count).toBeGreaterThan(2);
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.patch).toHaveBeenCalledTimes(result.count - 1);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.remote.size).toBe(2);
    for (const content of result.contents) {
      expect(card(content).header.title.content).toContain('思考详情');
      expect(content).not.toContain('工具编辑');
      expect(card(content).body.elements[1].text!.tag).toBe('plain_text');
      expect(body(content)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      const size = measureFeishuCard(content);
      expect(Math.max(size.bytes, size.requestBytes)).toBeLessThanOrEqual(3200);
      expect(content).toContain(`flow_detail:close:${id}`);
    }
    for (const [request] of [...mock.reply.mock.calls, ...mock.patch.mock.calls]) {
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(3200);
    }
  });

  it('freezes on open, keeps navigation stable through growth and reopens the latest full source after close', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const initial = '旧思考😀\n'.repeat(450);
    const id = register(details, '早期')!; bind(details, id);
    expect(register(details, initial)).toBe(id);
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    const boundBytes = details.stats.bytes - Buffer.byteLength(initial, 'utf8') - total(mock.remote.get('detail-1')!) * 16;
    const latest = initial + '新增全文🐾\n'.repeat(600);
    expect(register(details, latest)).toBe(id);
    const first = await readPages(details, id, mock);
    expect(first.text).toBe(initial);
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(total(mock.remote.get('detail-1')!)).toBe(first.count);
    expect(responseType(await action(details, id, 'close', mock.client))).toBe('success');
    expect(mock.del).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'detail-1' } });
    expect(mock.remote.get('source')).toBe('MAIN_CARD_UNCHANGED');
    expect(details.stats.bytes).toBe(boundBytes + Buffer.byteLength(latest, 'utf8') - Buffer.byteLength(initial, 'utf8'));
    expect(responseType(await page(details, id, 0, mock.client))).toBe('error');
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect((await readPages(details, id, mock, 'detail-2')).text).toBe(latest);
    expect(mock.reply).toHaveBeenCalledTimes(2);
    expect(responseType(await page(details, id, 1, mock.client, 'detail-1'))).toBe('error');
  });

  it('counts both live source and frozen text/offsets without retaining a snapshot per delta', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const initial = '原始😀'.repeat(200);
    const id = register(details, initial)!; bind(details, id);
    const boundBytes = details.stats.bytes;
    await open(details, id, mock.client);
    const frozenBytes = Buffer.byteLength(initial, 'utf8') + total(mock.remote.get('detail-1')!) * 16;
    expect(details.stats.bytes).toBe(boundBytes + frozenBytes);
    for (let n = 1; n <= 40; n++) {
      const text = initial + '新增🐾'.repeat(n);
      expect(register(details, text)).toBe(id);
      expect(details.stats).toEqual({
        entries: 1,
        bytes: boundBytes + frozenBytes + Buffer.byteLength(text, 'utf8') - Buffer.byteLength(initial, 'utf8'),
      });
    }
    expect(register(details, '短')).toBe(id);
    expect(details.stats.bytes).toBe(boundBytes + frozenBytes + Buffer.byteLength('短', 'utf8') - Buffer.byteLength(initial, 'utf8'));
    await action(details, id, 'close', mock.client);
    expect(details.stats.bytes).toBe(boundBytes + Buffer.byteLength('短', 'utf8') - Buffer.byteLength(initial, 'utf8'));
  });

  it('serializes duplicate opens while an in-flight open and growing registration preserve the frozen source', async () => {
    const details = store({ maxPending: 2 }); const mock = sdk(); const wait = gate();
    const initial = '打开时全文'; const id = register(details, initial)!; bind(details, id);
    const send = mock.reply.getMockImplementation()!;
    mock.reply.mockImplementationOnce(async (request) => { await wait.promise; return send(request); });
    const first = open(details, id, mock.client);
    await vi.waitFor(() => expect(mock.reply).toHaveBeenCalledTimes(1));
    expect(register(details, '增长后全文')).toBe(id);
    bind(details, id);
    const duplicate = open(details, id, mock.client);
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    wait.release();
    expect((await Promise.all([first, duplicate])).map(responseType)).toEqual(['success', 'success']);
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(body(mock.remote.get('detail-1')!)).toBe(initial);
    await action(details, id, 'close', mock.client);
    await open(details, id, mock.client);
    expect(body(mock.remote.get('detail-2')!)).toBe('增长后全文');
  });

  it('uses the latest source when an open waits behind a pending close and registration', async () => {
    const details = store(); const mock = sdk(); const wait = gate();
    const id = register(details, '最初')!; bind(details, id); await open(details, id, mock.client);
    const remove = mock.del.getMockImplementation()!;
    mock.del.mockImplementationOnce(async (request) => { await wait.promise; return remove(request); });
    const closing = action(details, id, 'close', mock.client);
    await vi.waitFor(() => expect(mock.del).toHaveBeenCalledTimes(1));
    const reopening = open(details, id, mock.client);
    expect(register(details, '关闭中收到最新全文')).toBe(id);
    wait.release();
    expect((await Promise.all([closing, reopening])).map(responseType)).toEqual(['success', 'success']);
    expect(body(mock.remote.get('detail-2')!)).toBe('关闭中收到最新全文');
    expect(mock.remote.get('source')).toBe('MAIN_CARD_UNCHANGED');
  });

  it('falls back to a thinking-specific closed placeholder, releases the frozen copy and patches latest on reopen', async () => {
    const details = store(); const mock = sdk();
    const id = register(details, '旧全文')!; bind(details, id);
    const baseline = details.stats.bytes;
    await open(details, id, mock.client);
    mock.del.mockResolvedValueOnce({ code: 230001 });
    expect(register(details, '最新全文')).toBe(id);
    expect(responseType(await action(details, id, 'close', mock.client))).toBe('success');
    const placeholder = mock.remote.get('detail-1')!;
    expect(placeholder).toContain('思考详情已关闭');
    expect(placeholder).not.toContain('工具');
    expect(placeholder).not.toContain('旧全文');
    expect(details.stats.bytes).toBe(baseline + Buffer.byteLength('最新全文', 'utf8') - Buffer.byteLength('旧全文', 'utf8'));
    expect(responseType(await page(details, id, 0, mock.client))).toBe('error');
    await open(details, id, mock.client);
    expect(body(mock.remote.get('detail-1')!)).toBe('最新全文');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.patch).toHaveBeenCalledTimes(2);
    expect(mock.patch.mock.calls.every(([request]) => request.path?.message_id === 'detail-1')).toBe(true);
    expect(mock.remote.get('source')).toBe('MAIN_CARD_UNCHANGED');
  });

  it('keeps the frozen copy on failed delete AND placeholder patch, and never reports close success', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const initial = '原全文😀'.repeat(450); const id = register(details, initial)!;
    bind(details, id); await open(details, id, mock.client);
    register(details, '当前全新内容');
    const before = details.stats;
    mock.del.mockRejectedValueOnce(new Error('private-error-not-for-toast'));
    mock.patch.mockResolvedValueOnce({ code: 230099 });
    const response = await action(details, id, 'close', mock.client);
    expect(responseType(response)).toBe('error');
    expect(JSON.stringify(response)).toContain('均未成功');
    expect(JSON.stringify(response)).not.toContain('private-error');
    expect(details.stats).toEqual(before);
    await open(details, id, mock.client);
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect((await readPages(details, id, mock)).text).toBe(initial);
  });

  it('supports official callbacks without thread_id and still rejects wrong owners/chats/sources/topics', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const id = register(details, '授权全文😀'.repeat(300))!;
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    bind(details, id);
    for (const mismatch of [
      { userId: 'other' }, { chatId: 'other' }, { threadId: 'other' },
      { messageId: 'root' }, { messageId: 'unrelated' }, { messageId: '' },
      { channelType: 'not-feishu' as InboundMessage['channelType'] },
    ]) {
      expect(responseType(await open(details, id, mock.client, { threadId: undefined, ...mismatch }))).toBe('error');
    }
    const official = (verb: string, messageId: string) => feishuCardActionToInbound({
      operator: { user_id: 'owner', open_id: 'ou-different' },
      context: { open_chat_id: 'chat', open_message_id: messageId },
      action: { value: { action: `flow_detail:${verb}:${id}` } },
    }).message!;
    expect(responseType(await details.handle(official('open', 'source'), mock.client, false))).toBe('error');
    expect(mock.reply).not.toHaveBeenCalled();
    expect(responseType(await details.handle(official('open', 'source'), mock.client, true))).toBe('success');
    const next = official('page', 'detail-1'); next.callbackData = `flow_detail:page:${id}:1`;
    for (const mismatch of [{ userId: 'other' }, { messageId: 'source' }, { threadId: 'wrong' }]) {
      expect(responseType(await details.handle({ ...next, ...mismatch }, mock.client, true))).toBe('error');
    }
    expect(responseType(await details.handle(next, mock.client, true))).toBe('success');
    expect(responseType(await details.handle(official('close', 'source'), mock.client, true))).toBe('error');
    expect(responseType(await details.handle(official('close', 'detail-1'), mock.client, true))).toBe('success');
    expect(mock.del).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'detail-1' } });
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('never transfers an existing thinking identity to a different owner/thread/reply route', async () => {
    const details = store(); const mock = sdk(); const id = register(details, '已绑定全文')!;
    bind(details, id);
    register(details, '增长全文');
    for (const override of [
      { flowDetailUserId: 'attacker' }, { threadId: 'other' }, { replyToMessageId: 'other-root' },
      { replyInThread: false }, { receiveIdType: 'open_id' }, { chatId: 'other-chat' },
    ]) bind(details, id, override, ['new-source']);
    expect(responseType(await open(details, id, mock.client, { messageId: 'new-source' }))).toBe('error');
    expect(responseType(await open(details, id, mock.client, { userId: 'attacker' }))).toBe('error');
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(mock.reply.mock.calls[0][0].path).toEqual({ message_id: 'root' });
    expect(body(mock.remote.get('detail-1')!)).toBe('增长全文');
  });

  it('bounds source authorization and permits same-scope main-card updates', async () => {
    const details = store({ maxSources: 2 }); const mock = sdk(); const id = register(details, '全文')!;
    bind(details, id);
    bind(details, id, {}, ['new-source', 'overflow']);
    expect(responseType(await open(details, id, mock.client, { messageId: 'overflow' }))).toBe('error');
    expect(responseType(await open(details, id, mock.client, { messageId: 'new-source' }))).toBe('success');
    expect(mock.reply).toHaveBeenCalledTimes(1);
  });

  it('expires by the original TTL despite repeated growth and frees live plus frozen retention', async () => {
    let now = 100;
    const details = store({ now: () => now, ttlMs: 50 }); const mock = sdk();
    const id = register(details, '最初')!; bind(details, id); await open(details, id, mock.client);
    now = 149;
    expect(register(details, '更新不会延长TTL')).toBe(id);
    now = 150;
    expect(responseType(await page(details, id, 0, mock.client))).toBe('error');
    expect(details.stats).toEqual({ entries: 0, bytes: 0 });
    expect(register(details, 'TTL后的全文')).not.toBe(id);
  });

  it('rejects an expired live update while a callback is pinned and revalidates queued opens after expiry', async () => {
    let now = 0;
    const details = store({ now: () => now, ttlMs: 100 }); const mock = sdk(); const wait = gate();
    const id = register(details, '打开全文')!; bind(details, id);
    const send = mock.reply.getMockImplementation()!;
    mock.reply.mockImplementationOnce(async (request) => { await wait.promise; return send(request); });
    const first = open(details, id, mock.client);
    await vi.waitFor(() => expect(mock.reply).toHaveBeenCalledTimes(1));
    const queued = open(details, id, mock.client);
    now = 100;
    expect(register(details, '过期后不偷偷重绑')).toBeUndefined();
    wait.release();
    expect(responseType(await first)).toBe('success');
    expect(responseType(await queued)).toBe('error');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(details.stats).toEqual({ entries: 0, bytes: 0 });
  });

  it('enforces shared entry limits and rejects new entries while existing callbacks are pinned', async () => {
    const details = store({ maxEntries: 1 }); const mock = sdk(); const wait = gate();
    const evicted = register(details, '旧条目', 'old')!;
    const id = register(details, '当前条目')!;
    expect(details.stats.entries).toBe(1);
    expect(responseType(await open(details, evicted, mock.client))).toBe('error');
    bind(details, id);
    const send = mock.reply.getMockImplementation()!;
    mock.reply.mockImplementationOnce(async (request) => { await wait.promise; return send(request); });
    const opening = open(details, id, mock.client);
    await vi.waitFor(() => expect(mock.reply).toHaveBeenCalledTimes(1));
    expect(register(details, '不能挤掉pending', 'another')).toBeUndefined();
    expect(details.register('chat', {
      toolId: 'write', inputData: { path: '/x', content: '工具编辑' }, toolResult: 'ok',
    })).toBeUndefined();
    expect(register(details, '同ID更新可以')).toBe(id);
    wait.release(); await opening;
    const toolId = details.register('chat', {
      toolId: 'write', inputData: { path: '/x', content: '工具编辑' }, toolResult: 'ok',
    });
    expect(toolId).toBeDefined();
    expect(details.stats.entries).toBe(1);
    expect(responseType(await open(details, id, mock.client))).toBe('error');
  });

  it('rejects over-capacity live replacement without losing the previously accepted source or frozen view', async () => {
    const details = store({ maxBytes: 6000 }); const mock = sdk();
    const id = register(details, 'x'.repeat(1000))!; bind(details, id); await open(details, id, mock.client);
    const before = details.stats;
    expect(register(details, 'y'.repeat(5000))).toBeUndefined();
    expect(details.stats).toEqual(before);
    expect(body(mock.remote.get('detail-1')!)).toBe('x'.repeat(1000));
    expect(register(details, 'z'.repeat(3000))).toBe(id);
    expect(details.stats.bytes).toBe(before.bytes + 2000);
    expect(details.stats.bytes).toBeLessThanOrEqual(6000);
    await action(details, id, 'close', mock.client);
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(details.stats.bytes).toBeLessThanOrEqual(6000);
    expect(register(details, '恢复容量')).toBe(id);
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(body(mock.remote.get('detail-2')!)).toBe('恢复容量');
    expect(register(details, '大'.repeat(10000), 'huge')).toBeUndefined();
  });

  it('refuses impossible component budgets and never splits a rejected detail into extra messages', async () => {
    const details = store({ pageBytes: 4000 }); const mock = sdk();
    const id = register(details, '全文😀'.repeat(1000))!; bind(details, id);
    configureFeishuCardBudget(mock.client, { maxBytes: 4000, maxElements: 1 });
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.reply).not.toHaveBeenCalled();
    configureFeishuCardBudget(mock.client, { maxBytes: 4000, maxElements: 60 });
    mock.reply.mockRejectedValueOnce(Object.assign(new Error('card too large'), { code: 230025 }));
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.remote.size).toBe(1);
  });

  it('preserves the same send UUID AND frozen text after an unknown response, then uses a new UUID only after confirmed close', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const initial = '响应丢失时全文😀'.repeat(300); const id = register(details, initial)!; bind(details, id);
    const send = mock.reply.getMockImplementation()!;
    mock.reply.mockImplementationOnce(async (request) => {
      await send(request);
      throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    });
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.remote.size).toBe(2);
    const before = details.stats;
    expect(register(details, '更新后全文🐾')).toBe(id);
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(mock.remote.size).toBe(2);
    expect(mock.reply.mock.calls[1][0].data.uuid).toBe(mock.reply.mock.calls[0][0].data.uuid);
    expect(mock.reply.mock.calls[1][0].data.content).toBe(mock.reply.mock.calls[0][0].data.content);
    expect(details.stats.bytes).toBe(before.bytes + Buffer.byteLength('更新后全文🐾', 'utf8') - Buffer.byteLength(initial, 'utf8'));
    expect((await readPages(details, id, mock)).text).toBe(initial);
    await action(details, id, 'close', mock.client);
    await open(details, id, mock.client);
    expect(mock.reply.mock.calls[2][0].data.uuid).not.toBe(mock.reply.mock.calls[0][0].data.uuid);
    expect(mock.remote.size).toBe(2);
    expect(body(mock.remote.get('detail-2')!)).toBe('更新后全文🐾');
  });

  it('retries failed page patches on the exact detail without committing the page early', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const id = register(details, '全文😀'.repeat(700))!; bind(details, id); await open(details, id, mock.client);
    mock.patch.mockResolvedValueOnce({ code: 230099 });
    expect(responseType(await page(details, id, 1, mock.client))).toBe('error');
    register(details, '新的源不影响重试');
    expect(responseType(await page(details, id, 1, mock.client))).toBe('success');
    expect(mock.patch).toHaveBeenCalledTimes(2);
    expect(mock.patch.mock.calls[1][0].data.content).toBe(mock.patch.mock.calls[0][0].data.content);
    expect(mock.remote.get('source')).toBe('MAIN_CARD_UNCHANGED');
  });
});
