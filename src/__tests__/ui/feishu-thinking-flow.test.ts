import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => Promise<Record<string, unknown>>>(),
  create: vi.fn(), reply: vi.fn(), patch: vi.fn(), remove: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { im = { message: { create: sdk.create, reply: sdk.reply, patch: sdk.patch, delete: sdk.remove } }; },
  EventDispatcher: class {
    register(handlers: Record<string, (event: unknown) => Promise<Record<string, unknown>>>) {
      for (const [key, value] of Object.entries(handlers)) sdk.handlers.set(key, value);
    }
  },
  WSClient: class { async start() {} close() {} },
}));
import { FeishuAdapter } from '../../server/channels/feishu/adapter.js';
import { fitsFeishuCard, resolveFeishuCardBudget } from '../../server/channels/feishu/card-budget.js';
import { estimatedTokenCount } from '../../server/channels/feishu/flow-blocks.js';

function nodes(value: unknown): Array<Record<string, any>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value as Record<string, any>, ...Object.values(value).flatMap(nodes)];
}
/** The 300-token budget is about the thought, not the fence that turns it into a code block. */
const thoughtBody = (content: unknown): string =>
  /^(`{3,})\n([\s\S]*)\n\1$/u.exec(String(content))?.[2] ?? String(content);
function buttonAction(value: unknown, label: string): string | undefined {
  const button = nodes(value).find(node => node.tag === 'button' && node.text?.content === label);
  return button?.behaviors?.[0]?.value?.action ?? button?.value?.action;
}

describe('thinking preview, full detail and close through the adapter SDK boundary', () => {
  let adapter: FeishuAdapter;
  let cards: Map<string, string>;
  let next: number;
  beforeEach(async () => {
    vi.resetAllMocks();
    sdk.handlers.clear();
    cards = new Map(); next = 0;
    const create = async (request: { data: { content: string } }) => {
      const messageId = `message-${++next}`;
      cards.set(messageId, request.data.content);
      return { code: 0, data: { message_id: messageId, thread_id: 'thread' } };
    };
    sdk.create.mockImplementation(create);
    sdk.reply.mockImplementation(create);
    sdk.patch.mockImplementation(async request => {
      cards.set(request.path.message_id, request.data.content);
      return { code: 0 };
    });
    sdk.remove.mockImplementation(async request => {
      cards.delete(request.path.message_id);
      return { code: 0 };
    });
    adapter = new FeishuAdapter({ appId: 'test', appSecret: 'test', verificationToken: '', encryptKey: '', allowedUsers: ['owner', 'other'] }, {
      botOpenId: 'bot', botName: 'test', cardFlow: { mode: 'blocks', groupGapTokens: 50, maxBytes: 4000, maxElements: 80, toolRules: {} },
    });
    await adapter.start();
  });
  afterEach(async () => { await adapter.stop(); });
  const data = (text: string, phase: ProgressData['phase'] = 'executing'): ProgressData => ({
    turnId: 'thinking-turn', phase, taskSummary: '任务', renderedText: '', elapsedSeconds: 1,
    totalTools: 0, todoItems: [], actionButtons: [], timeline: [{ kind: 'thinking', blockId: 'thought', text }],
  });
  const format = (text: string, phase: ProgressData['phase'] = 'executing') => ({
    ...adapter.format({ type: 'progress', chatId: 'chat', data: data(text, phase) }),
    flowDetailUserId: 'owner', threadId: 'thread', replyInThread: true,
    replyToMessageId: 'request', deliveryId: 'thinking-turn',
  });
  const trigger = (action: string, messageId: string, owner = 'owner', chat = 'chat') => sdk.handlers.get('card.action.trigger')!({
    operator: { user_id: owner, open_id: `open-${owner}` },
    action: { tag: 'button', value: { action } },
    // Official callback shape does not require thread_id.
    context: { open_chat_id: chat, open_message_id: messageId },
  });
  async function readAllPages(messageId: string): Promise<string> {
    const first = JSON.parse(cards.get(messageId)!);
    const total = Number(first.body.elements[0].text.content.match(/\/\s*(\d+)\s*页/)![1]);
    const pieces: string[] = [];
    for (let page = 0; page < total; page++) {
      const card = JSON.parse(cards.get(messageId)!);
      pieces.push(card.body.elements[1].text.content);
      const forward = buttonAction(card, '下一页');
      if (page + 1 < total) {
        expect(forward).toBeTruthy();
        expect(await trigger(forward!, messageId)).toMatchObject({ toast: { type: 'success' } });
      } else expect(forward).toBeUndefined();
    }
    expect(pieces).toHaveLength(total);
    return pieces.join('');
  }

  it('sends one bounded main card, restores every detail page and closes only the detail', async () => {
    const full = 'ORIGINAL_START' + '完整思考🐾\r\n'.repeat(1800) + 'ORIGINAL_END';
    const msg = format(full);
    const { messageId } = await adapter.send(msg);
    expect(cards.size).toBe(1);
    const main = cards.get(messageId)!;
    expect(main).not.toContain('ORIGINAL_START');
    expect(main).toContain('ORIGINAL_END');
    const preview = nodes(JSON.parse(main)).find(node => node.tag === 'markdown' && String(node.content).includes('ORIGINAL_END'))!;
    expect(estimatedTokenCount(thoughtBody(preview.content))).toBeLessThanOrEqual(300);
    const open = buttonAction(JSON.parse(main), '查看完整思考')!;
    expect(open).toBeTruthy();
    for (const args of [[open, messageId, 'other'], [open, messageId, 'owner', 'wrong'], [open, 'wrong']])
      expect(await trigger(...args as Parameters<typeof trigger>)).toMatchObject({ toast: { type: 'error' } });
    expect(cards.size).toBe(1);
    expect(await trigger(open, messageId)).toMatchObject({ toast: { type: 'success' } });
    const detailId = `message-${next}`;
    expect(cards.size).toBe(2);
    expect(cards.get(detailId)).toContain('思考');
    expect(await readAllPages(detailId)).toContain(full);
    const close = buttonAction(JSON.parse(cards.get(detailId)!), '关闭详情')!;
    expect(await trigger(close, detailId)).toMatchObject({ toast: { type: 'success' } });
    expect([...cards.keys()]).toEqual([messageId]);
    expect(cards.get(messageId)).toBe(main);
    expect(await adapter.consumeOne()).toBeNull();
    for (const [request] of [...sdk.reply.mock.calls, ...sdk.create.mock.calls, ...sdk.patch.mock.calls])
      expect(fitsFeishuCard(request.data.content, resolveFeishuCardBudget({ maxBytes: 4000, maxElements: 80 }))).toBe(true);
  });

  it('has a stable button during growth; open navigation freezes and reopen takes the latest full text', async () => {
    const initial = 'BEGIN' + '旧思考'.repeat(1500) + 'OLD_END';
    const { messageId } = await adapter.send(format(initial));
    const open = buttonAction(JSON.parse(cards.get(messageId)!), '查看完整思考')!;
    expect(await trigger(open, messageId)).toMatchObject({ toast: { type: 'success' } });
    const detailId = `message-${next}`;
    const frozenFirstPage = cards.get(detailId);
    const growing = initial + '新的思考'.repeat(600) + 'LATEST_APPEND_SENTINEL';
    await adapter.editMessage('chat', messageId, format(growing, 'completed'));
    const main = cards.get(messageId)!;
    expect(buttonAction(JSON.parse(main), '查看完整思考')).toBe(open);
    expect(main).toContain('LATEST_APPEND_SENTINEL');
    expect(main).not.toContain('OLD_END');
    expect(cards.get(detailId)).toBe(frozenFirstPage);
    const frozen = await readAllPages(detailId);
    expect(frozen).toContain(initial);
    expect(frozen).not.toContain('LATEST_APPEND_SENTINEL');
    const close = buttonAction(JSON.parse(cards.get(detailId)!), '关闭详情')!;
    await trigger(close, detailId);
    expect(await trigger(open, messageId)).toMatchObject({ toast: { type: 'success' } });
    const reopenedId = `message-${next}`;
    expect(await readAllPages(reopenedId)).toContain(growing);
    expect(await adapter.consumeOne()).toBeNull();
  });
});
