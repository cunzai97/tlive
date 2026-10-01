import type { ProgressData } from '../../shared/formatting/message-types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => Promise<Record<string, unknown>>>(),
  create: vi.fn(), reply: vi.fn(), patch: vi.fn(), remove: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    im = { message: { create: sdk.create, reply: sdk.reply, patch: sdk.patch, delete: sdk.remove } };
  },
  EventDispatcher: class {
    register(handlers: Record<string, (event: unknown) => Promise<Record<string, unknown>>>) {
      for (const [key, handler] of Object.entries(handlers)) sdk.handlers.set(key, handler);
    }
  },
  WSClient: class {
    async start() {}
    close() {}
  },
}));
import { FeishuAdapter } from '../../server/channels/feishu/adapter.js';
import { fitsFeishuCard, resolveFeishuCardBudget } from '../../server/channels/feishu/card-budget.js';

function actions(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(actions);
  const node = value as Record<string, unknown>;
  return [
    ...(typeof node.action === 'string' ? [node.action] : []),
    ...Object.values(node).flatMap(actions),
  ];
}

describe('Feishu block-flow integration at the mocked SDK boundary', () => {
  let adapter: FeishuAdapter;
  let cards: Map<string, string>;
  let next: number;
  beforeEach(async () => {
    vi.resetAllMocks();
    sdk.handlers.clear();
    cards = new Map();
    next = 0;
    const create = async (request: { data: { content: string } }) => {
      const id = `card-${++next}`;
      cards.set(id, request.data.content);
      return { code: 0, data: { message_id: id } };
    };
    sdk.create.mockImplementation(create);
    sdk.reply.mockImplementation(create);
    sdk.patch.mockImplementation(async (request) => {
      cards.set(request.path.message_id, request.data.content);
      return { code: 0 };
    });
    sdk.remove.mockImplementation(async (request) => {
      cards.delete(request.path.message_id);
      return { code: 0 };
    });
    adapter = new FeishuAdapter({
      appId: 'test', appSecret: 'test', verificationToken: '', encryptKey: '',
      allowedUsers: ['owner', 'other'],
    }, {
      botOpenId: 'bot', botName: 'testbot',
      cardFlow: {
        mode: 'blocks', groupGapTokens: 50, maxBytes: 4000, maxElements: 60,
        toolRules: { my_edit: 'edit', lookup: 'exploration' },
      },
    });
    await adapter.start();
  });
  afterEach(async () => { await adapter.stop(); });

  const progress = (timeline: ProgressData['timeline']): ProgressData => ({
    turnId: 'turn', phase: 'completed', renderedText: '', taskSummary: '测试', elapsedSeconds: 1,
    totalTools: 1, todoItems: [], actionButtons: [], timeline,
  });
  const trigger = (action: string, id: string, user = 'owner', chat = 'chat', thread = 'thread') => {
    const handler = sdk.handlers.get('card.action.trigger')!;
    return handler({
      operator: { user_id: user, open_id: `open-${user}` },
      action: { value: { action } },
      context: { chat_id: chat, thread_id: thread, open_message_id: id },
    });
  };

  it('registers and binds edit snapshots, opens one paginated card, navigates and closes without model routing', async () => {
    const content = '原始🐾片段'.repeat(1500);
    const message = adapter.format({ type: 'progress', chatId: 'chat', data: progress([
      { kind: 'thinking', blockId: 'thought', text: '长思考'.repeat(700) },
      { kind: 'tool', toolId: 'edit-1', toolName: 'my_edit', status: 'completed',
        inputData: { path: 'example.ts', content }, toolResult: '成功' },
    ]) });
    const result = await adapter.send({
      ...message, flowDetailUserId: 'owner', threadId: 'thread', replyInThread: true,
      replyToMessageId: 'source', deliveryId: 'turn',
    });
    expect(result.success).toBe(true);
    const [sourceId, sourceCard] = [...cards.entries()].find(([, card]) => actions(JSON.parse(card)).some((action) => action.startsWith('flow_detail:open:')))!;
    const open = actions(JSON.parse(sourceCard)).find((action) => action.startsWith('flow_detail:open:'))!;
    const before = cards.size;
    expect(await trigger(open, sourceId)).toMatchObject({ toast: { type: 'success' } });
    expect(cards.size).toBe(before + 1);
    const detailId = `card-${next}`;
    expect(cards.get(detailId)).toContain('只展示当前页');
    expect(cards.get(detailId)).toContain('example.ts');
    expect(cards.get(detailId)).not.toContain(content);
    const nextPage = actions(JSON.parse(cards.get(detailId)!)).find((action) => action.startsWith('flow_detail:page:'))!;
    expect(nextPage).toBeTruthy();
    expect(await trigger(nextPage, detailId)).toMatchObject({ toast: { type: 'success' } });
    expect(cards.size).toBe(before + 1);
    const close = actions(JSON.parse(cards.get(detailId)!)).find((action) => action.startsWith('flow_detail:close:'))!;
    expect(await trigger(close, detailId)).toMatchObject({ toast: { type: 'success' } });
    expect(cards.has(detailId)).toBe(false);
    expect(await adapter.consumeOne()).toBeNull();
    for (const request of [...sdk.reply.mock.calls, ...sdk.create.mock.calls, ...sdk.patch.mock.calls].map(([request]) => request)) {
      expect(fitsFeishuCard(request.data.content, resolveFeishuCardBudget({ maxBytes: 4000, maxElements: 60 }))).toBe(true);
    }
  });

  it('rejects other authorized users and cross-chat/thread/message clicks; malformed callbacks are consumed', async () => {
    const message = adapter.format({ type: 'progress', chatId: 'chat', data: progress([
      { kind: 'tool', toolId: 'e', toolName: 'write', status: 'completed', toolResult: 'ok',
        inputData: { path: 'x.ts', content: '历史快照' } },
    ]) });
    const { messageId } = await adapter.send({ ...message, flowDetailUserId: 'owner', threadId: 'thread', replyInThread: true, replyToMessageId: 'source' });
    const open = actions(message).find((action) => action.startsWith('flow_detail:open:'))!;
    for (const args of [
      [open, messageId, 'other'], [open, messageId, 'owner', 'wrong'],
      [open, messageId, 'owner', 'chat', 'wrong'], [open, 'wrong'],
      ['flow_detail:open:invalid', messageId],
    ]) {
      expect(await trigger(...args as Parameters<typeof trigger>)).toMatchObject({ toast: { type: 'error' } });
      expect(await adapter.consumeOne()).toBeNull();
    }
    expect(cards.size).toBe(1);
  });

  it('honors configured exploration mapping without retaining successful output in the card', async () => {
    const message = adapter.format({ type: 'progress', chatId: 'chat', data: progress([
      { kind: 'tool', toolId: 'read', toolName: 'lookup', toolInput: 'query', status: 'completed', toolResult: 'SUCCESS_OUTPUT_NOT_SENT' },
    ]) });
    await adapter.send(message);
    expect([...cards.values()].join('')).not.toContain('SUCCESS_OUTPUT_NOT_SENT');
    expect([...cards.values()].join('')).toContain('query');
  });
});
