import type { Client } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import { FeishuStreamingSession } from '../../server/channels/feishu/streaming.js';
import { configureFeishuCardBudget, fitsFeishuCard, getFeishuCardBudget } from '../../server/channels/feishu/card-budget.js';

function fixture(replyInThread = false) {
  const cards = new Map<string, string>();
  let next = 0;
  const create = vi.fn(async (request) => {
    const id = `message-${++next}`;
    cards.set(id, request.data.content);
    return { code: 0, data: { message_id: id } };
  });
  const reply = vi.fn(create);
  const patch = vi.fn(async (request) => {
    cards.set(request.path.message_id, request.data.content);
    return { code: 0 };
  });
  const remove = vi.fn(async (request) => {
    cards.delete(request.path.message_id);
    return { code: 0 };
  });
  const client = { im: { message: { create, reply, patch, delete: remove } } } as unknown as Client;
  configureFeishuCardBudget(client, { maxBytes: 4000, maxElements: 20 });
  const session = new FeishuStreamingSession({
    client, chatId: 'chat', replyToMessageId: 'source', replyInThread, throttleMs: 0,
    header: { template: 'blue', title: '生成中' },
  });
  const content = () => [...cards.values()].map((card) => {
    const value = JSON.parse(card);
    return value.body.elements.filter((element: { tag: string }) => element.tag === 'markdown')
      .map((element: { content: string }) => element.content).join('');
  }).join('');
  const assertBudgets = () => {
    for (const [request] of [...create.mock.calls, ...patch.mock.calls]) {
      expect(fitsFeishuCard(request.data.content, getFeishuCardBudget(client))).toBe(true);
    }
  };
  return { session, cards, content, create, reply, patch, remove, assertBudgets };
}

describe('lossless progressive Feishu session', () => {
  it('keeps full Unicode text through start/update/close and freezes sent prefixes', async () => {
    const f = fixture();
    const text = '中文🐾🙂'.repeat(3000);
    const root = await f.session.start(text.slice(0, 5000));
    const prefix = f.cards.get(root);
    await f.session.update(text);
    expect(f.content()).toBe(text);
    expect(f.cards.get(root)).toBe(prefix);
    expect(f.session.currentMessageId).toBe(root);
    expect(f.session.messageIds).toEqual([...f.cards.keys()]);
    await f.session.close({ finalText: text + '完整结尾', header: { template: 'green', title: '已完成' } });
    expect(f.content()).toBe(text + '完整结尾');
    expect([...f.cards.values()].every((card) => JSON.parse(card).header.title.content === '已完成')).toBe(true);
    f.assertBudgets();
  });

  it('retries a partial start using the same root and pending UUID', async () => {
    const f = fixture();
    const real = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(real).mockRejectedValueOnce(new Error('temporary failure'));
    const text = '续卡🐾'.repeat(3000);
    await expect(f.session.start(text)).rejects.toThrow('temporary failure');
    const root = [...f.cards.keys()][0];
    const uuid = f.create.mock.calls[1][0].data.uuid;
    await expect(f.session.start(text)).resolves.toBe(root);
    expect(f.create.mock.calls[2][0].data.uuid).toBe(uuid);
    expect(f.content()).toBe(text);
    f.assertBudgets();
  });

  it('does not poison the update queue or cache failed updates as successful', async () => {
    const f = fixture();
    await f.session.start('初始');
    f.patch.mockResolvedValueOnce({ code: 99991401, msg: 'permission denied' } as never);
    await expect(f.session.update('重试目标')).rejects.toThrow('permission denied');
    expect(f.content()).toBe('初始');
    await f.session.update('重试目标');
    expect(f.content()).toBe('重试目标');
    expect(f.patch).toHaveBeenCalledTimes(2);
    await f.session.close({ finalText: '' });
    expect(f.content()).toBe('');
    await expect(f.session.update('迟到结果')).rejects.toThrow('closed');
    await f.session.close();
  });

  it('serializes concurrent cumulative updates and preserves thread routing on continuations', async () => {
    const f = fixture(true);
    await f.session.start('开始');
    const text = '并发'.repeat(3000);
    await Promise.all([f.session.update(text), f.session.update(text + '最终')]);
    expect(f.content()).toBe(text + '最终');
    for (const [request] of f.reply.mock.calls) {
      expect(request.path.message_id).toBe('source');
      expect(request.data.reply_in_thread).toBe(true);
      expect(request.data.uuid).toBeTruthy();
    }
    expect(f.reply.mock.calls.length).toBeGreaterThan(1);
    f.assertBudgets();
  });

  it('does not silently accept updates or close before start', async () => {
    const f = fixture();
    await expect(f.session.update('未开始')).rejects.toThrow('has not started');
    await expect(f.session.close()).rejects.toThrow('has not started');
    expect(f.create).not.toHaveBeenCalled();
  });
});
