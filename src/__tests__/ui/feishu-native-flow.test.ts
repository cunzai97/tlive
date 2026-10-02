import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { QueryPresentationFactory } from '../../server/engine/coordinators/query-presentation.js';
import { classifyDefaultError } from '../../server/channels/errors.js';
import { configureFeishuCardBudget, fitsFeishuCard } from '../../server/channels/feishu/card-budget.js';
import { editFeishuMessage, getFeishuMessageIds, sendFeishuMessage } from '../../server/channels/feishu/sender.js';
import type { FeishuRenderedMessage } from '../../server/channels/feishu/types.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => Promise<Record<string, unknown>>>(),
  imCreate: vi.fn(), imReply: vi.fn(), imPatch: vi.fn(), imDelete: vi.fn(),
  cardCreate: vi.fn(), cardUpdate: vi.fn(), settings: vi.fn(),
  text: vi.fn(), elementUpdate: vi.fn(), elementPatch: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    im = { message: { create: sdk.imCreate, reply: sdk.imReply, patch: sdk.imPatch, delete: sdk.imDelete } };
    cardkit = { v1: {
      card: { create: sdk.cardCreate, update: sdk.cardUpdate, settings: sdk.settings },
      cardElement: { content: sdk.text, update: sdk.elementUpdate, patch: sdk.elementPatch },
    } };
  },
  EventDispatcher: class {
    register(handlers: Record<string, (event: unknown) => Promise<Record<string, unknown>>>) {
      for (const [key, handler] of Object.entries(handlers)) sdk.handlers.set(key, handler);
    }
  },
  WSClient: class { async start() {} close() {} },
}));
import { FeishuAdapter } from '../../server/channels/feishu/adapter.js';

let cards: Map<string, Record<string, any>>;
let messages: Map<string, string>;
let imUuids: Map<string, string>;
let counter: number;
let client: Client;
let adapter: FeishuAdapter;
let maxBytes: number;
const snapshots: Array<Record<string, any>> = [];

function nodes(value: unknown): Array<Record<string, any>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Record<string, any>;
  return [node, ...Object.values(node).flatMap(nodes)];
}
/** Thinking is fenced for Feishu's code block; assertions care about the body. */
const thoughtBody = (content: unknown): string =>
  /^(`{3,})\n([\s\S]*)\n\1$/u.exec(String(content))?.[2] ?? String(content);
const fenced = (body: string): string => `\`\`\`\n${body}\n\`\`\``;
function find(card: Record<string, any>, id: string) {
  const result = nodes(card).find((node) => node.element_id === id);
  if (!result) throw new Error(`Unknown SDK element ${id}`);
  return result;
}
function remoteMessage(id: string): Record<string, any> {
  const body = JSON.parse(messages.get(id)!);
  return body.type === 'card' ? cards.get(body.data.card_id)! : body;
}
function semanticText(_id: string): string {
  return [...messages.keys()].map(remoteMessage).flatMap(nodes)
    .filter((node) => node.tag === 'markdown')
    .map((node) => node.content).join('');
}
function callbackActions(card: Record<string, any>): string[] {
  return nodes(card).filter((node) => typeof node.action === 'string').map((node) => node.action);
}
function assertEntityBudgets() {
  for (const card of [...snapshots, ...cards.values()]) {
    expect(fitsFeishuCard(card, { maxBytes, maxElements: 160, maxTables: 4 })).toBe(true);
  }
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  let result!: T;
  let error: unknown;
  promise.then((value) => { result = value; done = true; }, (value) => { error = value; done = true; });
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(120);
  expect(done, 'SDK operation did not settle under bounded fake time').toBe(true);
  if (error) throw error;
  return result;
}
const progress = (timeline: ProgressData['timeline'], extra: Partial<ProgressData> = {}): ProgressData => ({
  turnId: 'turn', phase: 'executing', taskSummary: '原生流式', renderedText: '', elapsedSeconds: 0,
  totalTools: 0, todoItems: [], actionButtons: [], timeline, ...extra,
});
function message(text: string, enabled = true): FeishuRenderedMessage {
  return { chatId: 'chat', replyToMessageId: 'request', replyInThread: true, threadId: 'thread',
    deliveryId: 'native-turn', flowDetailUserId: 'owner',
    feishuHeader: { template: enabled ? 'blue' : 'green', title: enabled ? '执行中' : '已完成' },
    feishuElements: [{ tag: 'markdown', element_id: 'answer', content: text }],
    feishuStreaming: { enabled, elementIds: ['answer'] },
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks(); sdk.handlers.clear();
  cards = new Map(); messages = new Map(); imUuids = new Map(); snapshots.length = 0; counter = 0;
  maxBytes = 4000;
  const write = (id: string, card: Record<string, any>) => {
    cards.set(id, structuredClone(card)); snapshots.push(structuredClone(card));
  };
  sdk.cardCreate.mockImplementation(async (request) => {
    const id = String(++counter);
    write(id, JSON.parse(request.data.data));
    return { code: 0, data: { card_id: id } };
  });
  sdk.cardUpdate.mockImplementation(async (request) => {
    write(request.path.card_id, JSON.parse(request.data.card.data)); return { code: 0 };
  });
  sdk.settings.mockImplementation(async (request) => {
    const card = structuredClone(cards.get(request.path.card_id)!);
    const config = JSON.parse(request.data.settings);
    card.config = { ...card.config, ...config.config };
    write(request.path.card_id, card); return { code: 0 };
  });
  sdk.text.mockImplementation(async (request) => {
    const card = structuredClone(cards.get(request.path.card_id)!);
    expect(card.config.streaming_mode).toBe(true);
    // Native text updates must target an already delivered card, not an unsent entity.
    expect([...messages.values()].some((content) => {
      const value = JSON.parse(content); return value.type === 'card' && value.data.card_id === request.path.card_id;
    })).toBe(true);
    find(card, request.path.element_id).content = request.data.content;
    write(request.path.card_id, card); return { code: 0 };
  });
  sdk.elementUpdate.mockImplementation(async (request) => {
    const card = structuredClone(cards.get(request.path.card_id)!);
    Object.assign(find(card, request.path.element_id), JSON.parse(request.data.element));
    write(request.path.card_id, card); return { code: 0 };
  });
  sdk.elementPatch.mockImplementation(async (request) => {
    const card = structuredClone(cards.get(request.path.card_id)!);
    Object.assign(find(card, request.path.element_id), JSON.parse(request.data.partial_element));
    write(request.path.card_id, card); return { code: 0 };
  });
  const createMessage = async (request: { data: { content: string; uuid: string } }) => {
    const id = imUuids.get(request.data.uuid) ?? `message-${++counter}`;
    imUuids.set(request.data.uuid, id); messages.set(id, request.data.content);
    return { code: 0, data: { message_id: id, thread_id: 'thread' } };
  };
  sdk.imCreate.mockImplementation(createMessage); sdk.imReply.mockImplementation(createMessage);
  sdk.imPatch.mockImplementation(async (request) => { messages.set(request.path.message_id, request.data.content); return { code: 0 }; });
  sdk.imDelete.mockImplementation(async (request) => { messages.delete(request.path.message_id); return { code: 0 }; });
  adapter = new FeishuAdapter({ appId: 'test', appSecret: 'test', verificationToken: '', encryptKey: '', allowedUsers: ['owner'] }, {
    botOpenId: 'bot', botName: 'testbot',
    cardFlow: { mode: 'blocks', nativeStreaming: true, groupGapTokens: 50, maxBytes, maxElements: 160, toolRules: {} },
  });
  await adapter.start();
  client = (adapter as unknown as { client: Client }).client;
  configureFeishuCardBudget(client, { maxBytes, maxElements: 160 });
});
afterEach(async () => { await adapter.stop(); vi.useRealTimers(); });

describe('native flow on the real Feishu presentation/sender path', () => {
  it('prints cumulative deltas into the same delivered element, then honestly closes streaming', async () => {
    const first = await settle(adapter.send(message('第一段')));
    await settle(adapter.editMessage('chat', first.messageId, message('第一段，继续写')));
    const contentRequests = sdk.text.mock.calls.map(([request]) => request.data.content);
    expect(contentRequests).toContain('第一段');
    expect(contentRequests).toContain('第一段，继续写');
    expect(semanticText('answer')).toBe('第一段，继续写');
    expect(sdk.cardCreate).toHaveBeenCalledTimes(1);
    expect(sdk.cardUpdate).not.toHaveBeenCalled();
    expect(sdk.imPatch).not.toHaveBeenCalled();
    expect(sdk.imReply).toHaveBeenCalledTimes(1);
    await settle(adapter.editMessage('chat', first.messageId, message('第一段，继续写。完整结尾', false)));
    expect(semanticText('answer')).toBe('第一段，继续写。完整结尾');
    expect([...cards.values()].every((card) => card.config.streaming_mode === false)).toBe(true);
    assertEntityBudgets();
  });

  it.each([false, true])('shows an expanded first thought before any answer, tool or completion (startup card=%s)', async (startupCard) => {
    const factory = new QueryPresentationFactory({ defaultWorkdir: '/tmp' });
    const typing = { stop: vi.fn() };
    const turn = factory.createTurn({ adapter, msg: {
      channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner', text: '测试',
      messageId: 'request', replyInThread: true, replyTargetMessageId: 'request',
    }, binding: {}, sessionKey: 'session', reactions: { permission: 'Pin', processing: 'Typing', stalled: 'OneSecond' },
      typing, onMessageId() {} });
    try {
      if (startupCard) {
        turn.renderer.onSessionInfo({ tools: [] });
        await vi.advanceTimersByTimeAsync(1000);
      }
      turn.renderer.onThinkingDelta('我先分析');
      await vi.advanceTimersByTimeAsync(startupCard ? 500 : 120);
      expect(sdk.imReply).toHaveBeenCalledTimes(1);
      expect(typing.stop).toHaveBeenCalledTimes(1);
      const firstMessage = [...messages.keys()][0];
      const firstCard = remoteMessage(firstMessage);
      const panel = nodes(firstCard).find((node) => node.tag === 'collapsible_panel')!;
      expect(panel.expanded).toBe(true);
      expect(panel.header.title.content).toContain('进行中');
      expect(thoughtBody(nodes(panel).find((node) => node.tag === 'markdown')!.content)).toBe('我先分析');
      expect(firstCard.config.streaming_mode).toBe(true);
      expect(JSON.stringify(firstCard)).not.toContain('Starting');
      const firstElement = sdk.text.mock.calls.find(([request]) => request.data.content === fenced('我先分析'))![0].path;
      turn.renderer.onThinkingDelta('，还在继续思考');
      await vi.advanceTimersByTimeAsync(500);
      expect(sdk.text.mock.calls.some(([request]) => request.path.card_id === firstElement.card_id &&
        request.path.element_id === firstElement.element_id && request.data.content === fenced('我先分析，还在继续思考'))).toBe(true);
      expect(nodes(remoteMessage(firstMessage)).find((node) => node.tag === 'collapsible_panel')!.expanded).toBe(true);
      expect(sdk.cardCreate).toHaveBeenCalledTimes(1);
      expect(sdk.imPatch).not.toHaveBeenCalled();
      turn.renderer.onTextDelta('思考结束，开始回答');
      await vi.advanceTimersByTimeAsync(1000);
      expect(nodes(remoteMessage(firstMessage)).find((node) => node.tag === 'collapsible_panel')!.expanded).toBe(false);
      await settle(turn.renderer.onComplete());
      expect(remoteMessage(firstMessage).config.streaming_mode).toBe(false);
      assertEntityBudgets();
    } finally { turn.renderer.dispose(); }
  });

  it('keeps an already printed thought inside its code block across a structural change', async () => {
    const factory = new QueryPresentationFactory({ defaultWorkdir: '/tmp' });
    const turn = factory.createTurn({ adapter, msg: {
      channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner', text: '测试',
      messageId: 'request', replyInThread: true, replyTargetMessageId: 'request',
    }, binding: {}, sessionKey: 'session', reactions: { permission: 'Pin', processing: 'Typing', stalled: 'OneSecond' },
      typing: { stop() {} }, onMessageId() {} });
    try {
      turn.renderer.onThinkingDelta('我先分析');
      await vi.advanceTimersByTimeAsync(600);
      const printed = sdk.text.mock.calls.find(([request]) => thoughtBody(request.data.content) === '我先分析');
      expect(printed).toBeTruthy();
      const elementId = printed![0].path.element_id;
      // Starting a tool changes the card topology, which is where a fenced tail used to be wiped.
      turn.renderer.onToolStart('Read', { path: '/tmp/x' }, 'call-1');
      await vi.advanceTimersByTimeAsync(600);
      expect(sdk.text.mock.calls.filter(([request]) => request.path.element_id === elementId)
        .map(([request]) => request.data.content)).not.toContain('');
      const firstMessage = [...messages.keys()][0];
      const held = nodes(remoteMessage(firstMessage)).filter(node => node.tag === 'markdown')
        .map(node => node.content).filter(content => thoughtBody(content) === '我先分析');
      expect(held).toEqual([fenced('我先分析')]);
      await settle(turn.renderer.onComplete());
      assertEntityBudgets();
    } finally { turn.renderer.dispose(); }
  });

  it('streams actual query deltas before completion and retains scoped detail callbacks', async () => {
    const factory = new QueryPresentationFactory({ defaultWorkdir: '/tmp' });
    const turn = factory.createTurn({ adapter, msg: {
      channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner', text: '测试',
      messageId: 'request', replyInThread: true, replyTargetMessageId: 'request',
    }, binding: {}, sessionKey: 'session', reactions: { permission: 'Pin', processing: 'Typing', stalled: 'OneSecond' },
      typing: { stop() {} }, onMessageId() {} });
    try {
      turn.renderer.onThinkingDelta('先考虑一下');
      await vi.advanceTimersByTimeAsync(1500);
      expect(sdk.text).toHaveBeenCalled();
      turn.renderer.onTextDelta('正文开始');
      await vi.advanceTimersByTimeAsync(1500);
      turn.renderer.onTextDelta('，正文继续');
      await vi.advanceTimersByTimeAsync(1500);
      expect(sdk.text.mock.calls.some(([request]) => request.data.content === '正文开始，正文继续')).toBe(true);
      turn.renderer.onToolStart('write', { path: '/tmp/native-test.txt', content: '快照内容' }, 'write-call');
      turn.renderer.onToolResult('write-call', 'written', false);
      await vi.advanceTimersByTimeAsync(3000);
      const source = [...messages.keys()].find((id) => nodes(remoteMessage(id)).some((node) => node.tag === 'button' && node.text?.content === '查看新增内容'))!;
      expect(source).toBeTruthy();
      const button = nodes(remoteMessage(source)).find((node) => node.tag === 'button' && node.text?.content === '查看新增内容')!;
      const open = button.behaviors[0].value.action;
      const response = await settle(sdk.handlers.get('card.action.trigger')!({
        operator: { user_id: 'owner' }, context: { open_chat_id: 'chat', open_message_id: source },
        action: { value: { action: open } },
      }));
      expect(response).toMatchObject({ toast: { type: 'success' } });
      expect(await adapter.consumeOne()).toBeNull();
      turn.renderer.onTextDelta('任务完成');
      await settle(turn.renderer.onComplete());
      expect([...cards.values()].every((card) => card.config.streaming_mode === false)).toBe(true);
      expect([...messages.keys()].map(remoteMessage).some((card) => JSON.stringify(card).includes('快照内容'))).toBe(true);
      assertEntityBudgets();
    } finally { turn.renderer.dispose(); }
  });

  it('continues long Unicode without truncation and closes filled pages before leaving the active tail', async () => {
    const text = '汉字🐾🙂'.repeat(1800);
    const result = await settle(adapter.send(message(text.slice(0, 1200))));
    await settle(adapter.editMessage('chat', result.messageId, message(text)));
    expect(semanticText('answer')).toBe(text);
    expect(messages.size).toBeGreaterThan(2);
    expect(getFeishuMessageIds(client, result.messageId)).toEqual([...messages.keys()]);
    const values = [...messages.keys()].map(remoteMessage);
    expect(values.slice(0, -1).every((card) => card.config.streaming_mode === false)).toBe(true);
    expect(values.at(-1)!.config.streaming_mode).toBe(true);
    await settle(adapter.editMessage('chat', result.messageId, message(text + '完整结尾', false)));
    expect(semanticText('answer')).toBe(text + '完整结尾');
    expect([...cards.values()].every((card) => card.config.streaming_mode === false)).toBe(true);
    assertEntityBudgets();
  });

  it('reuses both the entity and message UUID after an IM send response is lost', async () => {
    const send = sdk.imReply.getMockImplementation()!;
    sdk.imReply.mockImplementationOnce(async (...args) => { await send(...args); throw new Error('response lost'); });
    await expect(settle(adapter.send(message('不得重复')))).rejects.toThrow('response lost');
    const first = sdk.imReply.mock.calls[0][0];
    const result = await settle(adapter.send({ ...message('不得重复') }));
    expect(messages.size).toBe(1);
    expect(sdk.cardCreate).toHaveBeenCalledTimes(1);
    expect(sdk.imReply.mock.calls[1][0].data).toEqual(first.data);
    expect(getFeishuMessageIds(client, result.messageId)).toHaveLength(1);
    expect(semanticText('answer')).toBe('不得重复');
  });

  it('does not downgrade permission errors to an ordinary send or duplicate the existing bubble', async () => {
    const result = await settle(adapter.send(message('已有前缀')));
    sdk.text.mockResolvedValueOnce({ code: 99991401, msg: 'permission denied' });
    await expect(settle(adapter.editMessage('chat', result.messageId, message('已有前缀，新内容')))).rejects.toThrow('permission denied');
    expect(messages.size).toBe(1);
    expect(sdk.imPatch).not.toHaveBeenCalled();
    await settle(adapter.editMessage('chat', result.messageId, message('已有前缀，新内容')));
    expect(semanticText('answer')).toBe('已有前缀，新内容');
  });

  it('lowers only the unsent suffix budget after a CardKit capacity rejection', async () => {
    const create = sdk.cardCreate.getMockImplementation()!;
    sdk.cardCreate.mockImplementationOnce(create)
      .mockResolvedValueOnce({ code: 200860, msg: 'card too large' });
    const text = '容量重试汉字'.repeat(1800);
    const result = await settle(adapter.send(message(text)));
    expect(semanticText('answer')).toBe(text);
    expect(messages.size).toBeGreaterThan(2);
    expect(new Set([...sdk.imReply.mock.calls].map(([request]) => request.data.uuid)).size).toBe(messages.size);
    expect(getFeishuMessageIds(client, result.messageId)).toEqual([...messages.keys()]);
    assertEntityBudgets();
  });

  it('keeps source order when an early already-paginated block grows', async () => {
    const msg: FeishuRenderedMessage = { ...message(''), feishuElements: [
      { tag: 'markdown', element_id: 'early', content: 'A'.repeat(12000) },
      { tag: 'markdown', element_id: 'later', content: 'B'.repeat(12000) },
    ], feishuStreaming: { enabled: true, elementIds: ['early', 'later'] } };
    const result = await settle(sendFeishuMessage(client, msg, classifyDefaultError));
    await settle(editFeishuMessage(client, result.messageId, { ...msg, feishuElements: [
      { tag: 'markdown', element_id: 'early', content: 'A'.repeat(12000) + 'NEW' },
      { tag: 'markdown', element_id: 'later', content: 'B'.repeat(12000) },
    ] }));
    const text = [...messages.keys()].map(remoteMessage).flatMap(nodes)
      .filter((node) => node.tag === 'markdown').map((node) => node.content).join('');
    expect(text).toBe('A'.repeat(12000) + 'NEW' + 'B'.repeat(12000));
    assertEntityBudgets();
  });

  it('retains content-operation identity across a lost response before applying a newer delta', async () => {
    const result = await settle(adapter.send(message('已有前缀')));
    const content = sdk.text.getMockImplementation()!;
    sdk.text.mockImplementationOnce(async (...args) => { await content(...args); throw new Error('content response lost'); });
    await expect(settle(adapter.editMessage('chat', result.messageId, message('已有前缀，第一批')))).rejects.toThrow('content response lost');
    const failed = sdk.text.mock.calls.at(-1)![0];
    await settle(adapter.editMessage('chat', result.messageId, message('已有前缀，第一批，第二批')));
    const calls = sdk.text.mock.calls.map(([request]) => request);
    expect(calls[calls.length - 2]).toEqual(failed);
    expect(calls.at(-1)!.data.sequence).toBeGreaterThan(failed.data.sequence);
    expect(calls.at(-1)!.data.uuid).not.toBe(failed.data.uuid);
    expect(semanticText('answer')).toBe('已有前缀，第一批，第二批');
    expect(messages.size).toBe(1);
  });

  it('does not report completion when closing streaming fails, and replays the same close', async () => {
    const result = await settle(adapter.send(message('最后内容')));
    const settings = sdk.settings.getMockImplementation()!;
    sdk.settings.mockImplementationOnce(async (...args) => { await settings(...args); throw new Error('close response lost'); });
    await expect(settle(adapter.editMessage('chat', result.messageId, message('最后内容', false)))).rejects.toThrow('close response lost');
    const failed = sdk.settings.mock.calls.at(-1)![0];
    await settle(adapter.editMessage('chat', result.messageId, message('最后内容', false)));
    expect(sdk.settings.mock.calls.at(-1)![0]).toEqual(failed);
    expect([...cards.values()].every((card) => card.config.streaming_mode === false)).toBe(true);
    expect(messages.size).toBe(1);
  });

  it('keeps the explicit native-off fallback on the normal multi-card budget path', async () => {
    const ordinary = new FeishuAdapter({ appId: 'test', appSecret: 'test', verificationToken: '', encryptKey: '', allowedUsers: [] }, {
      botOpenId: 'bot', botName: 'bot', cardFlow: { mode: 'blocks', nativeStreaming: false, groupGapTokens: 50, maxBytes, maxElements: 160, toolRules: {} },
    });
    await ordinary.start();
    try {
      const msg = ordinary.format({ type: 'progress', chatId: 'chat', data: progress([{ kind: 'text', blockId: 'x', text: '整卡回退' }]) });
      expect(msg.feishuStreaming).toBeUndefined();
      await settle(ordinary.send(msg));
      expect(sdk.cardCreate).not.toHaveBeenCalled();
      expect(JSON.parse([...messages.values()][0]).schema).toBe('2.0');
    } finally { await ordinary.stop(); }
  });
});

async function withSnapshotTurn(
  run: (turn: ReturnType<QueryPresentationFactory['createTurn']>, ordinary: FeishuAdapter) => Promise<void>,
): Promise<void> {
  maxBytes = 24000;
  const ordinary = new FeishuAdapter({ appId: 'test', appSecret: 'test', verificationToken: '', encryptKey: '', allowedUsers: ['owner'] }, {
    botOpenId: 'bot', botName: 'testbot',
    cardFlow: { mode: 'blocks', groupGapTokens: 50, maxBytes, maxElements: 160, toolRules: {} },
  });
  await ordinary.start();
  const factory = new QueryPresentationFactory({ defaultWorkdir: '/tmp' });
  const turn = factory.createTurn({ adapter: ordinary, msg: {
    channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner', text: '测试快照刷新',
    messageId: 'request', replyInThread: true, replyTargetMessageId: 'request',
  }, binding: {}, sessionKey: 'session', reactions: { permission: 'Pin', processing: 'Typing', stalled: 'OneSecond' },
    typing: { stop() {} }, onMessageId() {} });
  try { await run(turn, ordinary); }
  finally { turn.renderer.dispose(); await ordinary.stop(); }
}

describe('400ms latest-state snapshots without a typing animation', () => {
  it('shows the first thought immediately and replaces long/fast output at 400ms without CardKit', async () => {
    await withSnapshotTurn(async (turn, ordinary) => {
      expect(ordinary.usesNativeProgressStreaming()).toBe(false);
      expect(ordinary.format({ type: 'progress', chatId: 'chat', data: progress([]) }).feishuStreaming).toBeUndefined();
      const updates: number[] = [];
      const patch = sdk.imPatch.getMockImplementation()!;
      sdk.imPatch.mockImplementation(async (request) => { updates.push(Date.now()); return patch(request); });
      const start = Date.now();
      turn.renderer.onThinkingDelta('第一段思考');
      await vi.advanceTimersByTimeAsync(0);
      expect(sdk.imReply).toHaveBeenCalledTimes(1);
      const id = [...messages.keys()][0];
      expect(nodes(remoteMessage(id)).find((node) => node.tag === 'collapsible_panel')!.expanded).toBe(true);
      expect(messages.get(id)).toContain('第一段思考');
      turn.renderer.onThinkingDelta('，继续分析');
      await vi.advanceTimersByTimeAsync(399);
      expect(sdk.imPatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(updates.map(time => time - start)).toEqual([400]);
      expect(messages.get(id)).toContain('第一段思考，继续分析');
      const text = '正文' + 'x'.repeat(12000);
      turn.renderer.onTextDelta(text);
      await vi.advanceTimersByTimeAsync(400);
      expect(updates.map(time => time - start)).toEqual([400, 800]);
      expect(messages.get(id)).toContain(text);
      expect(nodes(remoteMessage(id)).find((node) => node.tag === 'collapsible_panel')!.expanded).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sdk.imPatch).toHaveBeenCalledTimes(2);
      await settle(turn.renderer.onComplete());
      expect(sdk.imReply).toHaveBeenCalledTimes(1);
      expect(sdk.cardCreate).not.toHaveBeenCalled();
      expect(sdk.text).not.toHaveBeenCalled();
      for (const request of [...sdk.imReply.mock.calls, ...sdk.imPatch.mock.calls].map(([value]) => value)) {
        const card = JSON.parse(request.data.content);
        expect(card.config.streaming_mode).not.toBe(true);
        expect(card.config.streaming_config).toBeUndefined();
        expect(fitsFeishuCard(card, { maxBytes, maxElements: 160, maxTables: 4 })).toBe(true);
      }
    });
  });

  it('does not add another 400ms after a slow first send and coalesces its pending deltas', async () => {
    await withSnapshotTurn(async (turn) => {
      const send = sdk.imReply.getMockImplementation()!;
      sdk.imReply.mockImplementationOnce(async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 150)); return send(...args);
      });
      const start = Date.now();
      const updates: number[] = [];
      const patch = sdk.imPatch.getMockImplementation()!;
      sdk.imPatch.mockImplementation(async (request) => { updates.push(Date.now()); return patch(request); });
      turn.renderer.onThinkingDelta('一');
      await vi.advanceTimersByTimeAsync(20);
      turn.renderer.onThinkingDelta('二');
      await vi.advanceTimersByTimeAsync(20);
      turn.renderer.onThinkingDelta('三');
      await vi.advanceTimersByTimeAsync(110);
      expect(sdk.imReply).toHaveBeenCalledTimes(1);
      expect(sdk.imPatch).not.toHaveBeenCalled();
      turn.renderer.onThinkingDelta('四');
      await vi.advanceTimersByTimeAsync(250);
      expect(updates.map(time => time - start)).toEqual([400]);
      expect([...messages.values()][0]).toContain('一二三四');
      expect(sdk.imReply).toHaveBeenCalledTimes(1);
      await settle(turn.renderer.onComplete());
    });
  });

  it('serializes slow requests and sends only the latest accumulated state as soon as one finishes', async () => {
    await withSnapshotTurn(async (turn) => {
      const updates: Array<{ at: number; content: string }> = [];
      const patch = sdk.imPatch.getMockImplementation()!;
      let inflight = 0; let maxInflight = 0;
      sdk.imPatch.mockImplementation(async (request) => {
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        updates.push({ at: Date.now(), content: request.data.content });
        try { await new Promise(resolve => setTimeout(resolve, 600)); return await patch(request); }
        finally { inflight--; }
      });
      const start = Date.now();
      turn.renderer.onThinkingDelta('开始');
      await vi.advanceTimersByTimeAsync(0);
      turn.renderer.onThinkingDelta('第一批');
      await vi.advanceTimersByTimeAsync(400);
      for (const delta of ['二', '三', '四', '五', '最新']) {
        await vi.advanceTimersByTimeAsync(100);
        turn.renderer.onThinkingDelta(delta);
      }
      await vi.advanceTimersByTimeAsync(100);
      // A zero-delay continuation runs on the next timer tick, not inside the
      // just-completed request's callback.
      await vi.advanceTimersByTimeAsync(1);
      expect(updates.map(update => update.at - start)).toEqual([400, 1001]);
      expect(updates[1].content).toContain('开始第一批二三四五最新');
      expect(maxInflight).toBe(1);
      await vi.advanceTimersByTimeAsync(600);
      expect([...messages.values()][0]).toContain('开始第一批二三四五最新');
      expect(updates).toHaveLength(2);
      await settle(turn.renderer.onComplete());
      expect(maxInflight).toBe(1);
      expect(sdk.imReply).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps only the latest thought suffix on the real renderer path while retaining full scoped details', async () => {
    await withSnapshotTurn(async (turn) => {
      const first = 'OLD_THINKING_BEGIN' + '旧思考'.repeat(2000);
      turn.renderer.onThinkingDelta(first);
      await vi.advanceTimersByTimeAsync(0);
      const source = [...messages.keys()][0];
      expect(messages.size).toBe(1);
      expect(messages.get(source)).not.toContain('OLD_THINKING_BEGIN');
      const open = callbackActions(remoteMessage(source)).find(action => action.startsWith('flow_detail:open:'))!;
      expect(open).toBeTruthy();
      turn.renderer.onThinkingDelta('新的思考'.repeat(1200) + 'LATEST_THOUGHT_END');
      await vi.advanceTimersByTimeAsync(400);
      expect(messages.size).toBe(1);
      const main = messages.get(source)!;
      expect(main).toContain('LATEST_THOUGHT_END');
      expect(main).not.toContain('旧思考'.repeat(50));
      expect(callbackActions(remoteMessage(source))).toContain(open);
      expect(Buffer.byteLength(main, 'utf8')).toBeLessThan(4000);
      const invoke = (action: string, messageId: string) => sdk.handlers.get('card.action.trigger')!({
        operator: { user_id: 'owner' },
        context: { open_chat_id: 'chat', open_message_id: messageId },
        action: { tag: 'button', value: { action } },
      });
      expect(await settle(invoke(open, source))).toMatchObject({ toast: { type: 'success' } });
      const detailId = [...messages.keys()].find(id => id !== source)!;
      expect(messages.get(detailId)).toContain('OLD_THINKING_BEGIN');
      expect(messages.size).toBe(2);
      const close = callbackActions(remoteMessage(detailId)).find(action => action.startsWith('flow_detail:close:'))!;
      await settle(invoke(close, detailId));
      expect([...messages.keys()]).toEqual([source]);
      expect(messages.get(source)).toBe(main);
      expect(await adapter.consumeOne()).toBeNull();
      await settle(turn.renderer.onComplete());
      expect(messages.get(source)).not.toContain('OLD_THINKING_BEGIN');
      expect(sdk.cardCreate).not.toHaveBeenCalled();
    });
  });

  it('protects each physical snapshot message at 400ms even for rapid terminal/state changes', async () => {
    await withSnapshotTurn(async (_turn, ordinary) => {
      const render = (text: string, phase: ProgressData['phase'] = 'executing') => ordinary.format({
        type: 'progress', chatId: 'chat', data: progress([{ kind: 'text', blockId: 'answer', text }], { phase }),
      });
      const initial = render('A');
      expect(initial.feishuSnapshot).toBe(true);
      const sent = await ordinary.send(initial);
      const updates: number[] = [];
      const patch = sdk.imPatch.getMockImplementation()!;
      sdk.imPatch.mockImplementation(async request => { updates.push(Date.now()); return patch(request); });
      const start = Date.now();
      const first = ordinary.editMessage('chat', sent.messageId, render('AB'));
      const second = ordinary.editMessage('chat', sent.messageId, render('ABC'));
      const terminal = ordinary.editMessage('chat', sent.messageId, render('ABCD', 'completed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(updates.map(time => time - start)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(399);
      expect(updates).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(updates.map(time => time - start)).toEqual([0, 400]);
      await vi.advanceTimersByTimeAsync(400);
      await Promise.all([first, second, terminal]);
      expect(updates.map(time => time - start)).toEqual([0, 400, 800]);
      expect(messages.get(sent.messageId)).toContain('ABCD');
      expect(sdk.imCreate).toHaveBeenCalledTimes(1);
    });
  });
});
