import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageRenderer,
  type MessageRendererOptions,
  type MessageRendererState,
} from '../../server/engine/messages/renderer.js';
import {
  ProgressContentBuilder,
  type RenderInput,
} from '../../server/engine/messages/progress-builder.js';
import { redactSensitiveContent } from '../../shared/utils/content-filter.js';

describe('renderer lossless block flow', () => {
  const renderers: MessageRenderer[] = [];

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.dispose();
    vi.useRealTimers();
  });

  function create(options: Partial<MessageRendererOptions> = {}) {
    const states: MessageRendererState[] = [];
    const flush = vi.fn<MessageRendererOptions['flushCallback']>(async (_text, isEdit, _buttons, state) => {
      if (state) states.push(state);
      return isEdit ? undefined : `message-${states.length}`;
    });
    const renderer = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 10,
      channelOwnsPagination: true,
      flushCallback: flush,
      ...options,
    });
    renderers.push(renderer);
    return { renderer, states, flush };
  }

  async function advance(ms = 10) {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  function last(states: MessageRendererState[]) {
    expect(states.length).toBeGreaterThan(0);
    return states[states.length - 1];
  }

  it('keeps stable turn/block IDs and merges full consecutive deltas in original order', async () => {
    const { renderer, states } = create();
    const thought = 'thinking '.repeat(400);
    const answer = 'answer '.repeat(400);
    renderer.onThinkingDelta(thought);
    await advance();
    const first = last(states);
    renderer.onThinkingDelta('tail');
    renderer.onTextDelta(answer);
    renderer.onTextDelta('tail');
    renderer.onToolStart('Bash', { command: 'pwd' }, 'call-1');
    renderer.onThinkingDelta('second thought');
    renderer.onThinkingDelta(' tail');
    renderer.onTextDelta('second answer');
    renderer.onTextDelta(' tail');
    await advance();
    const state = last(states);
    expect(state.turnId).toBe(first.turnId);
    expect(state.turnId).toBeTruthy();
    expect(state.timeline.map((entry) => entry.kind)).toEqual([
      'thinking', 'text', 'tool', 'thinking', 'text',
    ]);
    expect(state.timeline.map((entry) => entry.text)).toEqual([
      `${thought}tail`, `${answer}tail`, undefined, 'second thought tail', 'second answer tail',
    ]);
    expect(state.thinkingText).toBe(`${thought}tailsecond thought tail`);
    expect(state.responseText).toBe(`${answer}tailsecond answer tail`);
    const ids = state.timeline.map((entry) => entry.blockId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(5);
    expect(ids[0]).toBe(first.timeline[0].blockId);
    renderer.onToolResult('call-1', 'done', false);
    await advance();
    expect(last(states).timeline.map((entry) => entry.blockId)).toEqual(ids);
    const other = create();
    other.renderer.onTextDelta('another turn');
    await advance();
    expect(last(other.states).turnId).not.toBe(state.turnId);
  });

  it('keeps same-name/input calls independent and makes duplicate starts idempotent', async () => {
    const { renderer, states } = create();
    renderer.onToolStart('Bash', { command: 'pwd' }, 'call-a');
    renderer.onToolStart('Bash', { command: 'pwd' }, 'call-a');
    renderer.onToolStart('Bash', { command: 'pwd' }, 'call-b');
    renderer.onToolResult('call-a', 'first result', false);
    await advance();
    expect(last(states)).toMatchObject({ totalTools: 2, currentTool: { toolId: 'call-b' } });
    renderer.onToolResult('call-b', 'second result', false);
    renderer.onToolStart('Bash', { command: 'changed duplicate' }, 'call-a');
    await advance();
    const state = last(states);
    expect(state.totalTools).toBe(2);
    expect(state.toolSummary).toContain('Bash ×2');
    expect(state.timeline.map((entry) => [entry.toolId, entry.toolResult])).toEqual([
      ['call-a', 'first result'], ['call-b', 'second result'],
    ]);
    expect(state.toolLogs.map((entry) => entry.toolId)).toEqual(['call-a', 'call-b']);
  });

  it.each([false, true])('backfills a result received before its start (error=%s)', async (isError) => {
    const { renderer, states } = create();
    renderer.onToolResult('early', 'cached result', isError);
    renderer.onToolStart('Bash', { command: 'pwd' }, 'early');
    await advance();
    expect(last(states).timeline).toEqual([
      expect.objectContaining({ toolId: 'early', toolResult: 'cached result', isError,
        status: isError ? 'failed' : 'completed' }),
    ]);
    expect(last(states).toolLogs[0]).toMatchObject({ result: 'cached result', isError });
    expect(last(states).currentTool).toBeNull();
  });

  it('preserves full long input/result, redacts nested secrets and leaves provider input untouched', async () => {
    const { renderer, states } = create();
    const secret = 'sk-proj-abcdefghijklmnopqrstuv';
    const command = `echo ${secret}; ${'argument '.repeat(2000)}COMMAND-END`;
    const input = { command, nested: { password: 'plain-password', rows: [{ text: secret }] } };
    renderer.onToolStart('Bash', input, 'long');
    input.nested.rows.push({ text: 'provider later mutation' });
    const result = `RESULT-BEGIN ${'result '.repeat(2500)} ${secret} RESULT-END`;
    renderer.onToolResult('long', result, false);
    await advance();
    const state = last(states);
    const entry = state.timeline[0];
    expect(entry.inputData).toEqual({
      command: redactSensitiveContent(command),
      nested: { password: '[REDACTED]', rows: [{ text: 'sk-proj-[REDACTED]' }] },
    });
    expect(entry.inputData?.command).toContain('COMMAND-END');
    expect(entry.toolInput!.length).toBeLessThan(100);
    expect(entry.toolResult).toBe(redactSensitiveContent(result));
    expect(state.toolLogs[0].result).toBe(entry.toolResult);
    expect(state.toolLogs[0].inputData).toEqual(entry.inputData);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(state)).not.toContain('plain-password');
    expect(input.command).toBe(command);
    expect(input.nested.password).toBe('plain-password');
  });

  it('retains failed attempts through retries, duplicate completion and duplicate late results', async () => {
    const { renderer, states } = create();
    renderer.onToolStart('Bash', { command: 'same command' }, 'failed-attempt');
    renderer.onToolResult('failed-attempt', 'original failure', true);
    renderer.onApiRetry({ attempt: 1, maxRetries: 3, retryDelayMs: 100 });
    renderer.onToolStart('Bash', { command: 'same command' }, 'retry-attempt');
    renderer.onToolComplete('failed-attempt');
    renderer.onToolResult('failed-attempt', 'must not replace failure', false);
    await advance();
    expect(last(states).currentTool?.toolId).toBe('retry-attempt');
    renderer.onToolResult('retry-attempt', 'retry succeeded', false);
    await advance();
    expect(last(states).timeline.map((entry) => [entry.toolId, entry.status, entry.toolResult])).toEqual([
      ['failed-attempt', 'failed', 'original failure'],
      ['retry-attempt', 'completed', 'retry succeeded'],
    ]);
    expect(last(states).toolLogs[0]).toMatchObject({ status: 'failed', isError: true });
  });

  it.each(['Interrupted', 'transport failed'])('settles %s and attaches late results without reviving the attempt', async (error) => {
    const { renderer, states } = create();
    renderer.onToolStart('Bash', { command: 'pwd' }, 'original-attempt');
    await renderer.onError(error);
    const terminal = last(states);
    renderer.onToolResult('original-attempt', 'late result', false);
    renderer.onToolComplete('original-attempt');
    renderer.onToolStart('Bash', { command: 'ignored' }, 'new-attempt');
    renderer.onThinkingDelta('ignored thinking');
    renderer.onTextDelta('ignored text');
    await renderer.onComplete();
    const state = last(states);
    expect(state.phase).toBe('failed');
    expect(state.totalTools).toBe(1);
    expect(state.currentTool).toBeNull();
    expect(state.timeline).toEqual([
      expect.objectContaining({ toolId: 'original-attempt', toolResult: 'late result',
        status: error === 'Interrupted' ? 'interrupted' : 'failed' }),
    ]);
    expect(state.toolLogs[0].status).toBe(state.timeline[0].status);
    expect(state.responseText).toBe('');
    expect(terminal.timeline[0].toolResult).toBeUndefined();
  });

  it('keeps completion-settled failures terminal when their result arrives late', async () => {
    const { renderer, states } = create();
    renderer.onToolStart('Bash', { command: 'pwd' }, 'unfinished');
    await renderer.onComplete();
    renderer.onToolResult('unfinished', 'late success', false);
    await renderer.onComplete();
    expect(last(states).phase).toBe('completed');
    expect(last(states).timeline[0]).toMatchObject({ status: 'failed', toolResult: 'late success' });
    expect(last(states).currentTool).toBeNull();
  });

  it('lets Feishu own pagination without reset/discard beyond 12 tools and long text', async () => {
    const split = vi.fn(() => true);
    const { renderer, states, flush } = create({ platformLimit: 200, shouldSplitState: split });
    const thought = 'long thinking '.repeat(1500);
    const text = 'long answer '.repeat(2000);
    renderer.onThinkingDelta(thought);
    renderer.onTextDelta(text);
    await advance();
    const firstBlockId = last(states).timeline[0].blockId;
    for (let i = 0; i < 15; i++) {
      renderer.onToolStart('Bash', { command: `command-${i}` }, `call-${i}`);
      renderer.onToolResult(`call-${i}`, `result-${i}`, false);
      await advance();
    }
    renderer.onTextDelta('ANSWER-END');
    await advance();
    const state = last(states);
    expect(state.totalTools).toBe(15);
    expect(state.toolLogs).toHaveLength(15);
    expect(state.timeline).toHaveLength(18);
    expect(state.timeline[0]).toMatchObject({ blockId: firstBlockId, text: thought });
    expect(state.responseText).toBe(`${text}ANSWER-END`);
    expect(state.renderedText).toContain(text);
    expect(state.isContinuation).toBe(false);
    expect(flush.mock.calls.filter((call) => !call[1])).toHaveLength(1);
    expect(split).not.toHaveBeenCalled();
  });

  it('preserves legacy tool-count splitting for other channels and never reuses block IDs', async () => {
    const { renderer, states, flush } = create({ channelOwnsPagination: false, shouldSplitState: () => false });
    renderer.onTextDelta('first bubble');
    await advance();
    const firstBlock = last(states).timeline[0].blockId;
    for (let i = 0; i < 12; i++) {
      renderer.onToolStart('Bash', { command: 'pwd' }, `legacy-${i}`);
      await advance();
    }
    expect(flush.mock.calls.filter((call) => !call[1])).toHaveLength(2);
    expect(last(states).isContinuation).toBe(true);
    renderer.onTextDelta('second bubble');
    await renderer.onComplete();
    expect(last(states).timeline[0].blockId).not.toBe(firstBlock);
    expect(last(states).responseText).toBe('second bubble');
  });

  it('preserves legacy content-budget splitting when no channel predicate is provided', async () => {
    const { renderer, states, flush } = create({ channelOwnsPagination: false, platformLimit: 30_000 });
    renderer.onTextDelta('first');
    await advance();
    renderer.onTextDelta('x'.repeat(15_000));
    await advance();
    expect(flush.mock.calls.filter((call) => !call[1])).toHaveLength(2);
    expect(states.some((state) => state.responseText === `first${'x'.repeat(15_000)}`)).toBe(true);
    expect(last(states).responseText).toBe('');
  });

  it('does not mutate an in-flight snapshot on subsequent deltas, progress or results', async () => {
    const snapshots: MessageRendererState[] = [];
    let release!: (id: string) => void;
    const flush = vi.fn<MessageRendererOptions['flushCallback']>((_text, isEdit, _buttons, state) => {
      if (state) snapshots.push(state);
      return isEdit ? Promise.resolve(undefined) : new Promise((resolve) => { release = resolve; });
    });
    const { renderer } = create({ flushCallback: flush });
    renderer.onToolStart('Bash', { command: 'pwd', nested: { rows: ['original'] } }, 'async');
    renderer.onTextDelta('first');
    await advance();
    const snapshot = snapshots[0];
    const before = structuredClone(snapshot);
    renderer.onTextDelta(' second');
    renderer.onToolProgress({ toolName: 'Bash', elapsed: 9000 });
    renderer.onToolResult('async', 'result after snapshot', false);
    renderer.onToolStart('Read', { file_path: '/later' }, 'later');
    await advance();
    expect(snapshot).toEqual(before);
    release('async-message');
    await advance();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].responseText).toBe('first second');
    const oldInput = snapshot.timeline[0].inputData as { nested: { rows: string[] } };
    oldInput.nested.rows.push('consumer mutation');
    renderer.onTextDelta(' third');
    await advance();
    expect(snapshots.at(-1)?.timeline[0].inputData).toMatchObject({ nested: { rows: ['original'] } });
  });

  it('getStateSnapshot deep-copies every mutable field including timeline inputData', () => {
    const input: RenderInput = {
      turnId: 'snapshot-turn', phase: 'executing', responseText: 'answer', thinkingText: 'thought',
      elapsedSeconds: 1, totalTools: 1, toolCounts: new Map([['Bash', 1]]), bubbleToolCount: 1,
      currentTool: { name: 'Bash', input: 'pwd', elapsed: 1 },
      todoItems: [{ content: 'todo', status: 'pending' }],
      toolLogs: [{ name: 'Bash', input: 'pwd', inputData: { nested: { rows: ['log'] } } }],
      timeline: [{ kind: 'tool', inputData: { nested: { rows: ['timeline'] } } }],
      permissionQueue: [], permissionRequests: 0, completed: false, platformLimit: 4096,
      sessionInfo: { tools: ['Bash'], skills: ['skill'], mcpServers: [{ name: 'mcp', status: 'ok' }] },
      contextUsage: { tokens: 1, contextWindow: 100, percent: 1 },
      apiRetry: { attempt: 1, maxRetries: 3, retryDelayMs: 1 },
    };
    const builder = new ProgressContentBuilder();
    const snapshot = builder.getStateSnapshot(input, 'rendered');
    const before = structuredClone(snapshot);
    input.currentTool!.elapsed = 99;
    input.todoItems[0].content = 'changed';
    (input.timeline[0].inputData as { nested: { rows: string[] } }).nested.rows.push('changed');
    (input.toolLogs[0].inputData as { nested: { rows: string[] } }).nested.rows.push('changed');
    input.sessionInfo!.tools!.push('changed');
    input.sessionInfo!.mcpServers![0].status = 'changed';
    input.contextUsage!.tokens = 99;
    input.apiRetry!.attempt = 99;
    expect(snapshot).toEqual(before);
  });
});
