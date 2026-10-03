import { describe, expect, it } from 'vitest';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { PiAdapter } from '../../client/providers/pi-adapter.js';

describe('PiAdapter', () => {
  it('maps text, thinking, and tool execution events', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });

    expect(adapter.mapEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    } as any)).toEqual([{ kind: 'text_delta', text: 'hello' }]);

    expect(adapter.mapEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' },
    } as any)).toEqual([{ kind: 'thinking_delta', text: 'thinking' }]);

    expect(adapter.mapEvent({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'npm test' },
    } as any)).toEqual([
      {
        kind: 'tool_start',
        id: 'tool-1',
        name: 'bash',
        input: { command: 'npm test' },
      },
    ]);

    expect(adapter.mapEvent({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      isError: false,
    } as any)).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'tool-1',
        content: 'ok',
        isError: false,
        isFinal: true,
      },
    ]);
  });

  it('maps final usage into a canonical query result', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    const messages = [
      {
        role: 'assistant',
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          cost: { total: 0.01 },
        },
      },
    ];

    expect(adapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages,
    } as any)).toEqual([]);
    expect(adapter.mapComplete(messages, 17)).toEqual([
      {
        kind: 'query_result',
        sessionId: 'pi-session',
        isError: false,
        usage: {
          inputTokens: 13,
          outputTokens: 4,
          cachedInputTokens: 2,
          contextTokens: 17,
          costUsd: 0.01,
        },
      },
    ]);

    expect(adapter.mapComplete()).toEqual([]);
  });

  it('uses current-turn messages across multiple conversations and falls back after an empty agent_end', () => {
    const previousTurn = assistantUsage(1000, 100, 800);
    const currentTurn = assistantUsage(20, 5, 15);

    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    adapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages: [currentTurn],
    } as any);

    expect(adapter.mapComplete([previousTurn, currentTurn], 40)[0]).toMatchObject({
      usage: {
        inputTokens: 35,
        cachedInputTokens: 15,
        outputTokens: 5,
        contextTokens: 40,
      },
    });

    const emptyEndAdapter = new PiAdapter({ sessionId: 'pi-session' });
    emptyEndAdapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages: [],
    } as any);

    expect(emptyEndAdapter.mapComplete([currentTurn], 40)[0]).toMatchObject({
      usage: {
        inputTokens: 35,
        cachedInputTokens: 15,
        outputTokens: 5,
        contextTokens: 40,
      },
    });
  });

  it('reports both compaction phases so the indicator can clear', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });

    expect(
      adapter.mapEvent({ type: 'compaction_start', reason: 'threshold' } as any),
    ).toEqual([{ kind: 'compact_boundary', trigger: 'auto', phase: 'start' }]);

    expect(
      adapter.mapEvent({
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 's', firstKeptEntryId: 'e4', tokensBefore: 99072 },
        aborted: false,
        willRetry: false,
      } as any),
    ).toEqual([
      { kind: 'compact_boundary', trigger: 'manual', phase: 'end', preTokens: 99072 },
    ]);

    expect(
      adapter.mapEvent({
        type: 'compaction_end',
        reason: 'overflow',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: 'Context overflow recovery failed',
      } as any),
    ).toEqual([
      {
        kind: 'compact_boundary',
        trigger: 'auto',
        phase: 'end',
        errorMessage: 'Context overflow recovery failed',
      },
    ]);
  });
});

describe('PiAdapter live write progress', () => {
  const updateWith = (type: string, block: Record<string, unknown>) => ({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type, contentIndex: 0, delta: 'x', partial: { content: [block] } },
  });
  const writeBlock = (content: string, overrides: Record<string, unknown> = {}) => ({
    type: 'toolCall',
    id: 'call-1',
    name: 'write',
    arguments: { path: 'src/a.ts', content },
    ...overrides,
  });

  it('publishes the streaming file as a tool_progress snapshot', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });

    expect(adapter.mapEvent(updateWith('toolcall_delta', writeBlock('line1\nline2\n')) as any)).toEqual([
      {
        kind: 'tool_progress',
        toolName: 'write',
        elapsed: 0,
        path: 'src/a.ts',
        contentTail: 'line1\nline2\n',
        contentChars: 12,
        contentLines: 3,
      },
    ]);
  });

  it('stays silent until the call is recognisably a file writer', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });

    expect(adapter.mapEvent(updateWith('toolcall_delta', {
      type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'ls' },
    }) as any)).toEqual([]);
    expect(adapter.mapEvent(updateWith('toolcall_delta', {
      type: 'toolCall', id: 'c3', arguments: { content: 'unnamed so far' },
    }) as any)).toEqual([]);
    expect(adapter.mapEvent(updateWith('toolcall_delta', {
      type: 'toolCall', id: 'c4', name: 'write', arguments: { path: 'src/b.ts' },
    }) as any)).toEqual([]);
  });

  it('throttles deltas but never withholds the finished arguments', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    const first = adapter.mapEvent(updateWith('toolcall_delta', writeBlock('a\n')) as any);
    const second = adapter.mapEvent(updateWith('toolcall_delta', writeBlock('a\nb\n')) as any);
    const end = adapter.mapEvent(updateWith('toolcall_end', writeBlock('a\nb\nc\n')) as any);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(end[0]).toMatchObject({ contentTail: 'a\nb\nc\n', contentChars: 6, contentLines: 4 });
  });

  it('bounds the wire payload to a tail window while reporting the true totals', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    const content = `${'h'.repeat(9_000)}\nlast`;

    const [event] = adapter.mapEvent(updateWith('toolcall_end', writeBlock(content)) as any) as any[];

    expect(event.contentTail).toHaveLength(4_000);
    expect(event.contentTail).toBe(content.slice(-4_000));
    expect(event.contentChars).toBe(content.length);
    expect(event.contentLines).toBe(2);
  });

  it('starts each turn unthrottled, since the adapter lives for one turn', () => {
    const first = new PiAdapter({ sessionId: 'pi-session' }).mapEvent(
      updateWith('toolcall_delta', writeBlock('a\n')) as any,
    );
    const nextTurn = new PiAdapter({ sessionId: 'pi-session' }).mapEvent(
      updateWith('toolcall_delta', writeBlock('a\nb\n')) as any,
    );

    expect(first).toHaveLength(1);
    expect(nextTurn).toHaveLength(1);
  });
});

function assistantUsage(input: number, output: number, cacheRead: number): unknown {
  return {
    role: 'assistant',
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      cost: { total: 0 },
    },
  };
}

describe('PiAdapter step usage', () => {
  const assistant = (usage: Record<string, unknown>, stopReason = 'toolUse') => ({
    type: 'message_end',
    message: { role: 'assistant', stopReason, content: [], usage },
  } as any);

  const started = (adapter: PiAdapter, id: string) =>
    adapter.mapEvent({
      type: 'tool_execution_start',
      toolCallId: id,
      toolName: 'bash',
      args: {},
    } as any)[0] as Extract<CanonicalEvent, { kind: 'tool_start' }>;

  it('attributes the round-trip that produced the call, excluding cached reads', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    adapter.updateRuntime({ contextWindow: 128000 });
    adapter.mapEvent(assistant({ input: 3000, output: 200, cacheRead: 55000, cacheWrite: 200, totalTokens: 0 }));

    expect(started(adapter, 'call-1')).toMatchObject({
      usage: { step: 1, inputTokens: 3200, outputTokens: 200, contextTokens: 58400, contextWindow: 128000 },
    });
    // Parallel calls share one round-trip: the same step number is what lets the card dedupe.
    expect(started(adapter, 'call-2')).toMatchObject({ usage: { step: 1, contextTokens: 58400 } });
  });

  it('numbers a later round-trip separately and prefers the provider total', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    adapter.mapEvent(assistant({ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 999 }));
    expect(started(adapter, 'call-1')).toMatchObject({ usage: { step: 1, contextTokens: 999 } });
    adapter.mapEvent(assistant({ input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }));
    expect(started(adapter, 'call-2')).toMatchObject({ usage: { step: 2, inputTokens: 20, contextTokens: 25 } });
  });

  it('carries no usage until a complete round-trip exists', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    expect(started(adapter, 'call-1')).not.toHaveProperty('usage');
    // An aborted or empty message has partial numbers, so nothing is attributed from it.
    adapter.mapEvent(assistant({ input: 5000, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, 'aborted'));
    adapter.mapEvent(assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }));
    expect(started(adapter, 'call-2')).not.toHaveProperty('usage');
  });

  it('omits the window when the model never reported one', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    adapter.mapEvent(assistant({ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 }));
    expect(started(adapter, 'call-1')).toMatchObject({ usage: { step: 1, contextTokens: 14 } });
    expect(started(adapter, 'call-1').usage).not.toHaveProperty('contextWindow');
  });
});
