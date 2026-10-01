import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import type { RenderedMessage as OutboundMessage, InboundMessage } from '../../server/channels/types.js';
import { ConversationEngine } from '../../server/engine/conversation-engine.js';
import { CostTracker } from '../../server/engine/cost-tracker.js';
import { QueryContext } from '../../server/engine/coordinators/query-context.js';
import { QueryPresentationFactory } from '../../server/engine/coordinators/query-presentation.js';
import { QueryTurnRunner } from '../../server/engine/coordinators/query-turn-runner.js';
import { SessionStateManager } from '../../server/engine/state/session-state.js';
import { MessageRenderer, type MessageRendererState } from '../../server/engine/messages/renderer.js';

const start = (id: string, name = 'subagent'): CanonicalEvent => ({ kind: 'tool_start', id, name, input: { agent: 'worker', task: 'do work' } });
const result = (toolUseId: string, isFinal = true, isError = false): CanonicalEvent => ({ kind: 'tool_result', toolUseId, content: isError ? 'ACTUAL_FAILURE' : 'FULL_ORIGINAL_RESULT', isFinal, isError });
const text = (value: string): CanonicalEvent => ({ kind: 'text_delta', text: value });
const child = (parentToolUseId: string, status: 'running' | 'completed' = 'completed', childId = '0'): CanonicalEvent => ({
  kind: 'subagent_snapshot', parentToolUseId, childId, agentName: 'worker', task: 'task', status,
  timeline: [{ kind: 'text', blockId: 'child-block', text: `CHILD-${parentToolUseId}-${childId}` }],
});
const end: CanonicalEvent = { kind: 'query_result', sessionId: '', isError: false, usage: { inputTokens: 1, outputTokens: 1 } };
const renderers: MessageRenderer[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { renderers.splice(0).forEach(renderer => renderer.dispose()); vi.useRealTimers(); });

function harness(events: CanonicalEvent[], options: { channel?: string; send?: (message: OutboundMessage, attempt: number) => Promise<void>; edit?: () => Promise<void> } = {}) {
  const cards = new Map<string, OutboundMessage>();
  const deliveries = new Map<string, string>();
  const sends: OutboundMessage[] = [];
  const formats: any[] = [];
  const edits: Array<{ id: string; message: OutboundMessage }> = [];
  const formatter = new FeishuFormatter('zh');
  const channelType = options.channel ?? 'feishu';
  const adapter = {
    channelType, getLocale: () => 'zh', shouldRenderProgressPhase: () => true,
    shouldSplitCompletedTrace: () => false,
    format: (message: any) => { formats.push(structuredClone(message)); return formatter.format(message); },
    formatContent: (chat: string, content: string, buttons?: any) => formatter.formatContent(chat, content, buttons),
    send: vi.fn(async (message: OutboundMessage) => {
      sends.push(structuredClone(message));
      const identity = message.deliveryId ?? `unknown-${sends.length}`;
      let id = deliveries.get(identity);
      if (!id) { id = `card-${cards.size + 1}`; deliveries.set(identity, id); }
      cards.set(id, structuredClone(message)); // Commit before a possibly lost response.
      await options.send?.(message, sends.length);
      return { success: true, messageId: id };
    }),
    editMessage: vi.fn(async (_chat: string, id: string, message: OutboundMessage) => {
      edits.push({ id, message: structuredClone(message) });
      await options.edit?.();
      cards.set(id, structuredClone(message));
    }),
    addReaction: vi.fn(async () => {}), classifyError: (error: unknown) => error,
  } as unknown as BaseChannelAdapter;
  const inbound = { channelType, chatId: 'chat', userId: 'owner', messageId: 'source', text: 'run' } as InboundMessage;
  const presentation = new QueryPresentationFactory({ defaultWorkdir: '/tmp/project' }).createTurn({
    adapter, msg: inbound, binding: {}, sessionKey: 'session',
    reactions: { permission: 'pin', processing: 'typing', stalled: 'clock' },
    typing: { stop: vi.fn() }, onMessageId: vi.fn(),
  });
  renderers.push(presentation.renderer);
  const store = { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}) };
  const provider = { kind: 'pi', displayName: 'Pi', streamChat: () => ({ stream: new ReadableStream<CanonicalEvent>({
    start(controller) { for (const event of events) controller.enqueue(event); controller.close(); },
  }) }) };
  const sdkEngine = { getOrCreateSession: () => undefined, takeInitialPrompt: () => undefined, setControlsForChat: vi.fn() };
  const binding = { channelType, chatId: 'chat', sessionId: 'session', provider: 'pi' as const, createdAt: '' };
  const costs = new CostTracker(); costs.start();
  const query = new QueryContext(adapter, inbound, binding, 'session', presentation.renderer, costs,
    async () => 'allow', async () => ({}), vi.fn(), { requestId: 'request' } as any, presentation.subagents);
  const runner = new QueryTurnRunner({ engine: new ConversationEngine(store as any), providers: { require: () => provider } as any,
    store: store as any, state: new SessionStateManager(), sdkEngine: sdkEngine as any, defaultWorkdir: '/tmp/project', defaultAgentSettingSources: [] });
  let settled = false;
  const task = runner.run(query).finally(() => { settled = true; });
  const drain = async () => {
    for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(400);
    expect(settled).toBe(true);
    return task;
  };
  const mainCards = () => [...cards.values()].filter(message => !message.deliveryId?.includes(':subagent:'));
  return { ...presentation, cards, sends, edits, formats, mainCards, task, drain, settled: () => settled };
}

function progressData(h: ReturnType<typeof harness>) { return h.formats.filter(message => message.type === 'progress').map(message => message.data); }

describe('Feishu main-card continuation after a parent subagent tool settles', () => {
  it('delivers old main -> child -> independent main without duplicating the prior prefix', async () => {
    const h = harness([text('BEFORE_DELEGATION'), start('a'), child('a'), result('a'),
      { kind: 'thinking_delta', text: 'AFTER_THINKING' }, text('AFTER_ANSWER'), start('normal', 'Bash'), result('normal'), end]);
    await h.drain();
    expect([...h.cards.values()].map(message => message.deliveryId?.includes(':subagent:') ? 'child' : 'main')).toEqual(['main', 'child', 'main']);
    const [old, next] = h.mainCards();
    expect(JSON.stringify(old)).toContain('BEFORE_DELEGATION');
    expect(JSON.stringify(old)).not.toContain('AFTER_');
    expect(JSON.stringify(next)).toContain('AFTER_THINKING');
    expect(JSON.stringify(next)).toContain('AFTER_ANSWER');
    expect(JSON.stringify(next)).not.toContain('BEFORE_DELEGATION');
    expect(next.deliveryId).toBe(`${old.deliveryId}:segment:1`);
    const main = progressData(h).filter(data => !data.subagent);
    expect(new Set(main.map(data => data.turnId)).size).toBe(1);
    const last = main.at(-1);
    expect(last.totalTools).toBe(2);
    const before = main.find(data => data.timeline?.some((entry: any) => entry.toolId === 'a'));
    const previousIds = new Set(before.timeline.map((entry: any) => entry.blockId));
    expect(last.timeline.every((entry: any) => !previousIds.has(entry.blockId))).toBe(true);
  });

  it('keeps partial and child completion running until the parent final and exposes a final failure', async () => {
    const h = harness([start('a'), child('a', 'running'), result('a', false), text('DURING'), child('a'), result('a', true, true), text('AFTER'), end]);
    const toolResults = vi.spyOn(h.renderer, 'onToolResult');
    await h.drain();
    const running = progressData(h).find(data => !data.subagent && data.phase === 'executing');
    expect(running.timeline.find((entry: any) => entry.toolId === 'a').status).toBe('running');
    expect(running.timeline.find((entry: any) => entry.toolId === 'a').toolResult).toBeUndefined();
    expect(toolResults.mock.calls).toEqual([['a', '子代理未全部完成；请查看各自进度卡。', true]]);
    const [old, next] = h.mainCards();
    expect(JSON.stringify(old)).toContain('未全部完成');
    expect(JSON.stringify(old)).toContain('DURING');
    expect(JSON.stringify(old)).not.toContain('AFTER');
    expect(JSON.stringify(next)).toContain('AFTER');
  });

  it('waits for parallel parent calls and other pending main tools, sealing their finals together', async () => {
    const h = harness([start('a'), start('b'), start('normal', 'Bash'), child('a'), child('b'), result('a'),
      text('WAIT_OTHER'), result('b'), text('WAIT_NORMAL'), result('normal'), text('AFTER_GROUP'), end]);
    await h.drain();
    expect(h.cards.size).toBe(4);
    const [old, next] = h.mainCards();
    expect(JSON.stringify(old)).toContain('WAIT_OTHER');
    expect(JSON.stringify(old)).toContain('WAIT_NORMAL');
    expect(JSON.stringify(next)).toContain('AFTER_GROUP');
    expect(JSON.stringify(next)).not.toContain('WAIT_');
  });

  it('creates no continuation on empty deltas, metadata or terminal events without later content', async () => {
    const h = harness([start('a'), child('a'), result('a'), text(''), { kind: 'thinking_delta', text: '' },
      { kind: 'tool_use_summary', summary: 'summary' }, end]);
    await h.drain();
    expect(h.mainCards()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.cards.size).toBe(2);
  });

  it('uses one boundary per parent even with chain/multiple child slots and two successive delegations', async () => {
    const h = harness([text('PREFIX'), start('a'), child('a', 'completed', '0'), child('a', 'completed', '1'), result('a'),
      text('MIDDLE'), start('b'), child('b'), result('b'), text('SUFFIX'), end]);
    await h.drain();
    expect(h.mainCards()).toHaveLength(3);
    const [first, middle, last] = h.mainCards();
    expect([middle.deliveryId, last.deliveryId]).toEqual([`${first.deliveryId}:segment:1`, `${first.deliveryId}:segment:2`]);
    expect(JSON.stringify(middle)).toContain('MIDDLE');
    expect(JSON.stringify(middle)).not.toContain('PREFIX');
    expect(JSON.stringify(last)).toContain('SUFFIX');
    expect(JSON.stringify(last)).not.toContain('MIDDLE');
  });

  it('does not rotate messages for ordinary tools or a non-Feishu channel', async () => {
    const ordinary = harness([text('PREFIX'), start('normal', 'Bash'), result('normal'), text('SUFFIX'), end]);
    await ordinary.drain();
    expect(ordinary.mainCards()).toHaveLength(1);
    const other = harness([text('PREFIX'), start('a'), child('a'), result('a'), text('SUFFIX'), end], { channel: 'telegram' });
    await other.drain();
    expect(other.mainCards()).toHaveLength(1);
    expect(JSON.stringify(other.mainCards()[0])).toContain('PREFIX');
    expect(JSON.stringify(other.mainCards()[0])).toContain('SUFFIX');
  });

  it('waits for a slow first send before consuming child events and never binds its ID to the next segment', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness([text('PREFIX'), start('a'), child('a'), result('a'), text('SUFFIX'), end], { send: async (_message, attempt) => { if (attempt === 1) await gate; } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.cards.size).toBe(1);
    expect(h.settled()).toBe(false);
    release();
    await h.drain();
    expect(h.mainCards()).toHaveLength(2);
    expect(h.edits.filter(edit => edit.id === 'card-1').every(edit => !JSON.stringify(edit.message).includes('SUFFIX'))).toBe(true);
    expect(JSON.stringify(h.cards.get('card-3'))).toContain('SUFFIX');
  });

  it('retries an unknown first response with the same identity, then uses a distinct continuation identity', async () => {
    const h = harness([start('a'), child('a'), result('a'), text('SUFFIX'), end], { send: async (_message, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('committed; response lost'), { retryable: true });
    } });
    await h.drain();
    expect(h.sends[0].deliveryId).toBe(h.sends[1].deliveryId);
    expect(h.cards.size).toBe(3);
    expect(h.mainCards()).toHaveLength(2);
    expect(h.mainCards()[1].deliveryId).not.toBe(h.sends[0].deliveryId);
  });

  it('ignores duplicate final/start events from a sealed tool without copying it into the new main', async () => {
    const h = harness([start('a'), child('a'), result('a'), start('a'), result('a'), text('SUFFIX'), end]);
    await h.drain();
    expect(h.mainCards()).toHaveLength(2);
    const last = progressData(h).filter(data => !data.subagent).at(-1);
    expect(last.timeline.some((entry: any) => entry.toolId === 'a')).toBe(false);
    expect(last.totalTools).toBe(1);
  });

  it('waits for a slow sealing patch before accepting following main content', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness([text('PREFIX'), start('a'), child('a'), result('a'), text('SUFFIX'), end], { edit: () => gate });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.cards.size).toBe(2);
    expect(h.settled()).toBe(false);
    expect(h.formats.some(message => JSON.stringify(message.data).includes('SUFFIX'))).toBe(false);
    release();
    await h.drain();
    expect(h.cards.size).toBe(3);
    expect(JSON.stringify(h.mainCards()[0])).not.toContain('SUFFIX');
  });

  it('duplicate starts/finals from one sealed call cannot block a later delegation boundary', async () => {
    const h = harness([start('a'), child('a'), result('a'), start('a'), result('a'),
      text('MIDDLE'), start('b'), child('b'), result('b'), text('SUFFIX'), end]);
    await h.drain();
    expect(h.mainCards()).toHaveLength(3);
    expect(progressData(h).filter(data => !data.subagent).at(-1).totalTools).toBe(2);
  });

  it('continues refreshing each text delta in a new segment before query completion', async () => {
    const snapshots: MessageRendererState[] = [];
    let id = 0;
    const renderer = new MessageRenderer({ channelOwnsPagination: true, platformLimit: 4096, throttleMs: 400,
      flushCallback: async (_content, edit, _buttons, state) => { snapshots.push(state!); return edit ? undefined : `card-${++id}`; } });
    renderers.push(renderer);
    renderer.onToolStart('subagent', {}, 'a');
    renderer.onToolResult('a', 'done', false);
    await renderer.sealForContinuation();
    renderer.onTextDelta('FIRST');
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)?.responseText).toBe('FIRST');
    renderer.onTextDelta(' SECOND');
    await vi.advanceTimersByTimeAsync(400);
    expect(snapshots.at(-1)?.responseText).toBe('FIRST SECOND');
    expect(snapshots.at(-1)?.phase).toBe('executing');
    expect(id).toBe(2);
    await renderer.onComplete();
  });

  it('does not clear the old segment without a confirmed physical message', async () => {
    const renderer = new MessageRenderer({ channelOwnsPagination: true, platformLimit: 4096,
      flushCallback: async () => undefined });
    renderers.push(renderer);
    renderer.onTextDelta('UNCONFIRMED_PREFIX');
    await expect(renderer.sealForContinuation()).rejects.toThrow('no confirmed message ID');
    expect(renderer.getResponseText()).toBe('UNCONFIRMED_PREFIX');
  });
});
