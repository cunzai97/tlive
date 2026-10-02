import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import type { InboundMessage } from '../../server/channels/types.js';
import { QueryPresentationFactory } from '../../server/engine/coordinators/query-presentation.js';

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'run task',
    messageId: 'msg-1',
    ...overrides,
  };
}

function createAdapter(): BaseChannelAdapter {
  const formatter = new FeishuFormatter('zh');
  return {
    channelType: 'feishu',
    getLocale: vi.fn().mockReturnValue('zh'),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    shouldRenderProgressPhase: vi.fn().mockReturnValue(true),
    shouldSplitProgressMessage: vi.fn().mockReturnValue(false),
    shouldSplitCompletedTrace: vi.fn().mockReturnValue(false),
    format: vi.fn().mockImplementation((msg) => formatter.format(msg)),
    formatContent: vi.fn().mockImplementation((chatId, content, buttons) =>
      formatter.formatContent(chatId, content, buttons),
    ),
  } as unknown as BaseChannelAdapter;
}

describe('QueryPresentationFactory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const createTurn = (
    factory: QueryPresentationFactory,
    adapter: BaseChannelAdapter,
    sessionId: string,
  ) =>
    factory.createTurn({
      adapter,
      msg: createMessage(),
      binding: { cwd: '/work', sessionId, sdkSessionId: 'sdk-1' },
      sessionKey: 'feishu:chat-1:binding-1',
      reactions: { processing: 'Typing', permission: 'Pin', stalled: 'OneSecond' },
      typing: { stop: vi.fn() },
      onMessageId: vi.fn(),
    });

  it('starts and stops typing for a query attempt', async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const factory = new QueryPresentationFactory({
      defaultWorkdir: '/work',
      typingIntervalMs: 1000,
    });

    const typing = factory.startTyping(adapter, createMessage());

    expect(adapter.sendTyping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.sendTyping).toHaveBeenCalledTimes(2);

    typing.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(adapter.sendTyping).toHaveBeenCalledTimes(2);
  });

  it('wires presenter first-send message ids back to the query owner', async () => {
    const adapter = createAdapter();
    const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });
    const onMessageId = vi.fn();

    const { presenter } = factory.createTurn({
      adapter,
      msg: createMessage(),
      binding: { cwd: '/work', sdkSessionId: 'sdk-1' },
      sessionKey: 'feishu:chat-1:binding-1',
      reactions: {
        processing: 'Typing',
        done: 'OK',
        error: 'FACEPALM',
        stalled: 'OneSecond',
        permission: 'Pin',
      },
      typing: { stop: vi.fn() },
      onMessageId,
    } as any);

    await presenter.flush('hello', false);

    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1' }));
    expect(onMessageId).toHaveBeenCalledWith('out-1');
  });

  it('leaves oversized streamed text in one logical bubble for FeishuSender', async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });
    const { renderer } = factory.createTurn({
      adapter,
      msg: createMessage(),
      binding: { cwd: '/work', sdkSessionId: 'sdk-1' },
      sessionKey: 'feishu:chat-1:binding-1',
      reactions: {
        processing: 'Typing',
        done: 'OK',
        error: 'FACEPALM',
        stalled: 'OneSecond',
        permission: 'Pin',
      },
      typing: { stop: vi.fn() },
      onMessageId: vi.fn(),
    } as any);

    renderer.onTextDelta('a'.repeat(15_000));
    await vi.advanceTimersByTimeAsync(0);
    renderer.onTextDelta('b'.repeat(15_000));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).toHaveBeenCalled();
    renderer.dispose();
  });

  describe('session-level plan board', () => {
    const todos = {
      todos: [
        { content: '确认服务状态', status: 'in_progress' },
        { content: '提交任务', status: 'pending' },
        { content: '放弃的方案', status: 'cancelled' },
      ],
    };

    const cardsSent = (adapter: BaseChannelAdapter): string[] =>
      (adapter.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => JSON.stringify(call[0]?.feishuElements ?? call[0]),
      );

    it('feeds the plan into the bottom block and keeps the raw list out of the timeline', async () => {
      vi.useFakeTimers();
      const adapter = createAdapter();
      const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });
      const { renderer } = createTurn(factory, adapter, 'session-1');

      renderer.onToolStart('todo', todos, 'call-1');
      await vi.advanceTimersByTimeAsync(1_000);

      const [card] = cardsSent(adapter);
      expect(card).toContain('确认服务状态');
      expect(card).toContain('⛔ 放弃的方案');
      expect(card).toContain('collapsible_panel');
      expect(card).toContain('**todo**');
      // The list is presented once, as markers — never as the tool's own JSON.
      expect(card).not.toContain('\\"content\\"');
      expect(card).not.toContain('完整结果');
      renderer.dispose();
    });

    it('reaches the same card when the stack names the tool TodoWrite', async () => {
      vi.useFakeTimers();
      const adapter = createAdapter();
      const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });
      const { renderer } = createTurn(factory, adapter, 'session-claude');

      renderer.onToolStart('TodoWrite', todos, 'call-1');
      await vi.advanceTimersByTimeAsync(1_000);

      const [card] = cardsSent(adapter);
      expect(card).toContain('**TodoWrite**');
      expect(card).toContain('确认服务状态');
      expect(card).not.toContain('\\"content\\"');
      renderer.dispose();
    });

    it('still feeds the board for a name-hidden tool whose payload is a plan', async () => {
      vi.useFakeTimers();
      const adapter = createAdapter();
      const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });
      const { renderer } = createTurn(factory, adapter, 'session-hidden');

      renderer.onToolStart('TaskUpdate', todos, 'call-1');
      // A hidden tool contributes no timeline row, so the turn needs other content to send.
      renderer.onTextDelta('继续处理');
      await vi.advanceTimersByTimeAsync(1_000);

      const [card] = cardsSent(adapter);
      expect(card).toContain('继续处理');
      expect(card).toContain('确认服务状态');
      expect(card).not.toContain('TaskUpdate');
      renderer.dispose();
    });

    it('carries the plan onto the next turn card of the same session', async () => {
      vi.useFakeTimers();
      const adapter = createAdapter();
      const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });

      const first = createTurn(factory, adapter, 'session-1');
      first.renderer.onToolStart('todo', todos, 'call-1');
      await vi.advanceTimersByTimeAsync(1_000);
      first.renderer.dispose();

      const second = createTurn(factory, adapter, 'session-1');
      second.renderer.onTextDelta('继续');
      await vi.advanceTimersByTimeAsync(1_000);

      const cards = cardsSent(adapter);
      expect(cards.length).toBeGreaterThan(1);
      expect(cards[cards.length - 1]).toContain('提交任务');
      second.renderer.dispose();
    });

    it('starts empty when the session id rotates, which is what /new does', async () => {
      vi.useFakeTimers();
      const adapter = createAdapter();
      const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });

      const first = createTurn(factory, adapter, 'session-1');
      first.renderer.onToolStart('todo', todos, 'call-1');
      await vi.advanceTimersByTimeAsync(1_000);
      first.renderer.dispose();

      const next = createTurn(factory, adapter, 'session-2');
      next.renderer.onTextDelta('新会话');
      await vi.advanceTimersByTimeAsync(1_000);

      const cards = cardsSent(adapter);
      expect(cards[cards.length - 1]).not.toContain('确认服务状态');
      next.renderer.dispose();
    });

    it('keeps the board in step with provider-emitted todo updates', async () => {
      vi.useFakeTimers();
      const adapter = createAdapter();
      const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });

      const first = createTurn(factory, adapter, 'session-1');
      first.renderer.onTodoUpdate([{ content: '来自上游的步骤', status: 'completed' }]);
      await vi.advanceTimersByTimeAsync(1_000);
      first.renderer.dispose();

      const second = createTurn(factory, adapter, 'session-1');
      second.renderer.onTextDelta('继续');
      await vi.advanceTimersByTimeAsync(1_000);

      const cards = cardsSent(adapter);
      expect(cards[cards.length - 1]).toContain('来自上游的步骤');
      second.renderer.dispose();
    });
  });
});
