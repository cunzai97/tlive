import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageRenderer } from '../../server/engine/messages/renderer.js';
import {
  AdaptiveFlushController,
  type AdaptiveFlushOptions,
} from '../../server/engine/messages/adaptive-flush.js';

describe('MessageRenderer', () => {
  let flushCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) return Promise.resolve('msg-1');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRenderer(
    platformLimit = 4096,
    throttleMs = 300,
    cwd?: string,
    model?: string,
    verboseLevel: 0 | 1 = 1,
    shouldSplitState?: (state: any) => boolean,
    adaptiveFlush?: boolean | AdaptiveFlushOptions,
  ) {
    return new MessageRenderer({
      shouldSplitState,
      platformLimit,
      throttleMs,
      cwd,
      model,
      verboseLevel,
      adaptiveFlush,
      flushCallback: flushCallback as any,
    });
  }

  async function advance(ms: number) {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  const defaultButtons = [
    { label: 'Allow', callbackData: 'perm:allow:abc', style: 'primary' as const },
    { label: 'Deny', callbackData: 'perm:deny:abc', style: 'danger' as const },
  ];

  it('honors retry-after backoff outside the normal flush interval cap', () => {
    const controller = new AdaptiveFlushController({ minMs: 800, maxMs: 4000 });
    controller.recordRateLimit(60_000, 1000);

    expect(controller.nextDelay({
      fallbackMs: 300,
      content: 'running',
      phase: 'executing',
      hasMessage: true,
    }, 1000)).toBe(60_000);
  });

  it('uses a 400ms start-anchored cadence despite long/fast output and slow network latency', () => {
    const controller = new AdaptiveFlushController({
      baseMs: 400, minMs: 400, maxMs: 400, anchorToLastFlush: true,
    });
    controller.recordTextDelta(10000, 1000);
    controller.recordFlushLatency(1200);
    const input = { fallbackMs: 400, content: 'x'.repeat(30000), phase: 'executing',
      hasMessage: true, lastFlushAt: 1000 };
    expect(controller.nextDelay(input, 1000)).toBe(400);
    expect(controller.nextDelay(input, 1150)).toBe(250);
    expect(controller.nextDelay(input, 1400)).toBe(0);
    expect(controller.nextDelay(input, 2200)).toBe(0);
    expect(controller.nextDelay({ ...input, hasMessage: false }, 1000)).toBe(0);
  });

  it('does not subtract elapsed cadence time from an explicit rate-limit backoff', () => {
    const controller = new AdaptiveFlushController({
      baseMs: 400, minMs: 400, maxMs: 400, anchorToLastFlush: true,
    });
    controller.recordRateLimit(5000, 1000);
    expect(controller.nextDelay({ fallbackMs: 400, content: 'latest', phase: 'executing',
      hasMessage: true, lastFlushAt: 0 }, 2000)).toBe(4000);
  });

  it('escalates the penalty window while rejections keep landing inside it', () => {
    const controller = new AdaptiveFlushController({ minMs: 1000, maxMs: 1000 });
    const input = { fallbackMs: 1000, content: 'running', phase: 'executing', hasMessage: true };
    const windows: number[] = [];
    let now = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      controller.recordRateLimit(undefined, now);
      windows.push(controller.nextDelay(input, now));
      // A forced flush sneaks back in before the window closes, exactly like the 14 rejected
      // retries of one real turn, and has to make the next penalty longer rather than equal.
      now += 500;
    }
    expect(windows).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('keeps the penalty window in front of every short-circuit in nextDelay', () => {
    const controller = new AdaptiveFlushController({ minMs: 800, maxMs: 4000 });
    const input = {
      fallbackMs: 400,
      content: 'first frame',
      phase: 'executing',
      hasMessage: false,
    };
    controller.recordRateLimit(undefined, 1000);
    // No confirmed message yet, and the permission phase both used to answer "flush now", which
    // re-offered the rejected frame inside the window that the rejection itself just opened.
    expect(controller.nextDelay(input, 1000)).toBe(2000);
    expect(controller.nextDelay({ ...input, phase: 'waiting_permission' }, 1000)).toBe(2000);
    expect(controller.nextDelay({ ...input, hasMessage: true }, 2800)).toBe(800);
    expect(controller.nextDelay(input, 3000)).toBe(0);
  });

  it('restarts the escalation ladder after a frame gets through', () => {
    const controller = new AdaptiveFlushController({ minMs: 1000, maxMs: 1000 });
    controller.recordRateLimit(undefined, 0);
    controller.recordRateLimit(undefined, 500);
    expect(controller.remainingRateLimitMs(500)).toBe(4000);
    controller.recordFlushLatency(120);
    controller.recordRateLimit(undefined, 6000);
    expect(controller.remainingRateLimitMs(6000)).toBe(2000);
    expect(controller.remainingRateLimitMs(9000)).toBe(0);
  });

  it('renders executing progress with accumulated visible tools and quiet-mode suppression', async () => {
    const r = createRenderer();
    r.onToolStart('Bash');
    r.onToolStart('Read');
    r.onToolStart('Bash');
    await advance(1300);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(content).toContain('⏳');
    expect(content).toContain('🖥️ Bash ×2');
    expect(content).toContain('📖 Read ×1');
    expect(content).toContain('3 tools');
    r.dispose();

    flushCallback.mockClear();
    const quiet = createRenderer(4096, 300, undefined, undefined, 0);
    quiet.onToolStart('Bash');
    quiet.onTextDelta('working');
    await advance(1300);

    expect(flushCallback).not.toHaveBeenCalled();
    quiet.dispose();
  });

  it('uses adaptive timing after the first progress card', async () => {
    const r = createRenderer(4096, 300, undefined, undefined, 1, undefined, {
      baseMs: 800,
      minMs: 800,
      maxMs: 4000,
    });

    r.onTextDelta('hello');
    await advance(0);
    expect(flushCallback).toHaveBeenCalledTimes(1);

    r.onTextDelta(' world');
    await advance(300);
    expect(flushCallback).toHaveBeenCalledTimes(1);

    await advance(500);
    expect(flushCallback).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  it('morphs into permission state, passes controls, and restores executing state', async () => {
    const r = createRenderer();
    const longInput = 'npm test -- '.concat('schema.test.ts '.repeat(20));

    r.onToolStart('Bash');
    r.onToolStart('Read');
    r.onPermissionNeeded('Bash', longInput, 'perm-1', defaultButtons);
    await advance(0);

    let lastCall = flushCallback.mock.calls.at(-1)!;
    expect(lastCall[0]).toContain('🔐');
    expect(lastCall[0]).toContain(longInput);
    expect(lastCall[2]).toEqual(defaultButtons);

    r.onPermissionResolved();
    await advance(1300);

    lastCall = flushCallback.mock.calls.at(-1)!;
    expect(lastCall[0]).toContain('⏳');
    expect(lastCall[0]).toContain('Bash ×1');
    expect(lastCall[0]).toContain('Read ×1');
    expect(lastCall[0]).not.toContain('🔐');
    expect(lastCall[2]).toBeUndefined();
    r.dispose();
  });

  it('emits permission timeout only while the permission is still pending', async () => {
    let timeoutData: { toolName: string; input: string } | null = null;
    const r = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 300,
      flushCallback: flushCallback as any,
      onPermissionTimeout: (toolName, input) => {
        timeoutData = { toolName, input };
      },
    });

    r.onPermissionNeeded('Bash', 'npm test', '123', defaultButtons);
    await advance(59_000);
    expect(timeoutData).toBeNull();

    await advance(1_000);
    expect(timeoutData).toEqual({ toolName: 'Bash', input: 'npm test' });
    r.dispose();

    timeoutData = null;
    const resolved = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 300,
      flushCallback: flushCallback as any,
      onPermissionTimeout: (toolName, input) => {
        timeoutData = { toolName, input };
      },
    });
    resolved.onPermissionNeeded('Bash', 'npm test', '456', defaultButtons);
    await advance(30_000);
    resolved.onPermissionResolved();
    await advance(60_000);

    expect(timeoutData).toBeNull();
    resolved.dispose();
  });

  it('formats completion with answer, tool summary, hidden-tool filtering, runtime info, and usage', async () => {
    const r = createRenderer(4096, 300, '/home/user/workspace');
    r.setRuntimeInfo({
      provider: 'codex',
      displayName: 'Codex',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    });
    r.setUsageSummary('📊 10/4 tok | 2s');
    r.onToolStart('Bash');
    r.onToolStart('TaskCreate');
    r.onToolStart('Read');
    r.onTextDelta('Here is the result.');

    await r.onComplete();
    await advance(0);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(content).toContain('Here is the result.');
    expect(content).toContain('───────────────');
    expect(content).toContain('🖥️ Bash ×1');
    expect(content).toContain('📖 Read ×1');
    expect(content).toContain('2 total');
    expect(content).not.toContain('TaskCreate');
    expect(content).toContain('[gpt-5.5] │ 思考 xhigh │ /home/user/workspace');
    expect(content).toContain('📊 10/4 tok | 2s');
    r.dispose();
  });

  it('renders error states as either simple failures or stopped runs with partial output', async () => {
    const simple = createRenderer();
    simple.onError('connection refused');
    await advance(0);
    expect(flushCallback.mock.calls.at(-1)?.[0]).toBe('❌ connection refused');
    simple.dispose();

    flushCallback.mockClear();
    const partial = createRenderer();
    partial.onToolStart('Bash');
    partial.onTextDelta('Partial response...');
    partial.onError('stream interrupted');
    await advance(0);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(content).toContain('Partial response...');
    expect(content).toContain('❌ stream interrupted');
    expect(content).toContain('───────────────');
    partial.dispose();
  });

  it('sends the first progress bubble as a new message and later progress as edits', async () => {
    const r = createRenderer();
    r.onToolStart('Bash');
    await advance(300);

    expect(flushCallback).toHaveBeenCalledWith(
      expect.any(String),
      false,
      undefined,
      expect.objectContaining({ phase: 'executing', totalTools: 1 }),
    );
    expect(r.messageId).toBe('msg-1');

    r.onToolStart('Read');
    await advance(300);

    expect(flushCallback.mock.calls.at(-1)?.[1]).toBe(true);
    r.dispose();
  });

  it('coalesces concurrent flushes instead of racing duplicate sends', async () => {
    let resolveFirst: () => void;
    const slowCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        return new Promise<string>((resolve) => {
          resolveFirst = () => resolve('msg-1');
        });
      }
      return Promise.resolve();
    });
    const r = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 300,
      flushCallback: slowCallback as any,
    });

    r.onToolStart('Bash');
    await advance(1300);
    expect(slowCallback).toHaveBeenCalledTimes(1);

    r.onToolStart('Read');
    await advance(300);
    expect(slowCallback).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await advance(0);

    expect(slowCallback).toHaveBeenCalledTimes(2);
    expect(r.messageId).toBe('msg-1');
    r.dispose();
  });

  it('truncates executing progress but leaves completed content intact for outer chunking', async () => {
    const executing = createRenderer(200);
    for (let i = 0; i < 20; i++) {
      executing.onToolStart(`LongToolName${i}`);
    }
    await advance(300);

    const executingContent = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(executingContent.length).toBeLessThanOrEqual(200);
    expect(executingContent.startsWith('...\n')).toBe(true);
    executing.dispose();

    flushCallback.mockClear();
    const done = createRenderer(200);
    done.onToolStart('Bash');
    done.onTextDelta('x'.repeat(500));
    done.onComplete();
    await advance(0);

    const doneContent = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(doneContent.length).toBeGreaterThan(200);
    expect(doneContent).toContain('x'.repeat(500));
    done.dispose();
  });

  it('splits long-running progress into new bubbles but keeps completion in the current bubble', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });

    const r = createRenderer(4096, 300);
    r.onToolStart('Bash');
    await advance(300);

    for (let i = 0; i < 11; i++) {
      r.onToolStart('Read');
      await advance(300);
    }

    expect(messageIds).toEqual(['msg-1', 'msg-2']);
    expect(flushCallback.mock.calls.at(-1)?.[0]).toContain('继续执行');

    r.onTextDelta('Final answer');
    r.onComplete();
    await advance(0);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(messageIds).toEqual(['msg-1', 'msg-2']);
    expect(content).toContain('Final answer');
    expect(content).not.toContain('继续执行');
    r.dispose();
  });

  it('can split by content budget rather than only by tool count', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });
    const largeThought = '正在整理当前上下文并继续执行。'.repeat(500);
    const r = createRenderer(
      30_000,
      300,
      undefined,
      undefined,
      1,
      (state) => state.thinkingText.length >= largeThought.length * 2,
    );

    for (let i = 0; i < 3; i++) {
      r.onThinkingDelta(largeThought);
      await advance(300);
    }

    expect(messageIds.length).toBeGreaterThan(1);
    r.dispose();
  });

  it('keeps long assistant text in one logical bubble for the channel splitter', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });
    const r = createRenderer(30_000, 300);

    r.onTextDelta('a'.repeat(3000));
    await advance(0);
    r.onTextDelta('b'.repeat(2500));
    await advance(300);

    expect(messageIds).toEqual(['msg-1']);
    expect(flushCallback.mock.calls.at(-1)?.[0]).toContain('b'.repeat(2500));
    expect(flushCallback.mock.calls.at(-1)?.[1]).toBe(true);
    r.dispose();
  });

  it('disables the estimated-size fallback when the channel owns physical splitting', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });
    const r = createRenderer(30_000, 300, undefined, undefined, 1, () => false);

    r.onTextDelta('a'.repeat(15_000));
    await advance(0);
    r.onTextDelta('b'.repeat(15_000));
    await advance(300);

    expect(messageIds).toEqual(['msg-1']);
    expect(flushCallback.mock.calls.at(-1)?.[0]).toContain('b'.repeat(15_000));
    expect(flushCallback.mock.calls.at(-1)?.[1]).toBe(true);
    r.dispose();
  });

  it('keeps the default tool-count split even with a platform split predicate', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });

    const r = createRenderer(30_000, 300, undefined, undefined, 1, () => false);
    r.onToolStart('Bash');
    await advance(300);

    for (let i = 0; i < 11; i++) {
      r.onToolStart('Read', { file_path: `src/file-${i}.ts` });
      await advance(300);
    }

    expect(messageIds).toEqual(['msg-1', 'msg-2']);
    r.dispose();
  });

  it('stops timer-driven flushes after disposal or completion', async () => {
    const disposed = createRenderer();
    disposed.onToolStart('Bash');
    disposed.dispose();
    await advance(5000);
    expect(flushCallback).not.toHaveBeenCalled();

    const complete = createRenderer();
    complete.onToolStart('Bash');
    await advance(2000);

    const callsBefore = flushCallback.mock.calls.length;
    complete.onComplete();
    await advance(0);
    const callsAfterComplete = flushCallback.mock.calls.length;
    expect(callsAfterComplete).toBeGreaterThan(callsBefore);

    await advance(5000);
    expect(flushCallback.mock.calls.length).toBe(callsAfterComplete);
    complete.dispose();
  });

  it('clears the API retry indicator once the stream resumes', async () => {
    const renderer = createRenderer();

    renderer.onApiRetry({ attempt: 1, maxRetries: 5, retryDelayMs: 0, error: 'stream closed' });
    await advance(500);
    expect(flushCallback.mock.calls.at(-1)?.[3]).toMatchObject({
      apiRetry: { attempt: 1, maxRetries: 5 },
    });

    renderer.onTextDelta('the answer continues after the reconnect succeeded.');
    await advance(500);
    expect(flushCallback.mock.calls.at(-1)?.[3]?.apiRetry).toBeUndefined();

    renderer.dispose();
  });

  it('shows a streaming write and hands over to the tool block once it starts', async () => {
    const renderer = createRenderer();

    renderer.onToolProgress({
      toolName: 'write',
      elapsed: 0,
      path: 'src/a.ts',
      contentTail: 'line1\nline2\n',
      contentChars: 12,
      contentLines: 3,
    });
    await advance(500);
    expect(flushCallback.mock.calls.at(-1)?.[3]?.liveWrite).toEqual({
      name: 'write',
      path: 'src/a.ts',
      contentTail: 'line1\nline2\n',
      contentChars: 12,
      contentLines: 3,
    });

    renderer.onToolStart('write', { path: 'src/a.ts' }, 'call-1');
    await advance(500);
    expect(flushCallback.mock.calls.at(-1)?.[3]?.liveWrite).toBeNull();
    expect(flushCallback.mock.calls.at(-1)?.[3]?.currentTool).toMatchObject({ name: 'write' });

    renderer.dispose();
  });

  it('treats an elapsed-only progress event as elapsed-only', async () => {
    const renderer = createRenderer();

    renderer.onToolStart('Bash', { command: 'sleep 9' }, 'call-1');
    await advance(500);
    renderer.onToolProgress({ toolName: 'Bash', elapsed: 9000 });
    renderer.onTodoUpdate([{ content: 'still running', status: 'pending' }]);
    await advance(500);

    const state = flushCallback.mock.calls.at(-1)?.[3];
    expect(state?.liveWrite).toBeNull();
    expect(state?.currentTool).toMatchObject({ name: 'Bash', elapsed: 9 });

    renderer.dispose();
  });

  it('never carries a streaming write into a terminal frame', async () => {
    const renderer = createRenderer();

    renderer.onToolProgress({
      toolName: 'write',
      elapsed: 0,
      contentTail: 'half a file',
      contentChars: 11,
      contentLines: 1,
    });
    await advance(500);
    expect(flushCallback.mock.calls.at(-1)?.[3]?.liveWrite).toBeTruthy();

    await renderer.onError('Interrupted');
    const last = flushCallback.mock.calls.at(-1)?.[3];
    expect(last?.liveWrite).toBeNull();
    expect(last?.phase).toBe('failed');

    renderer.dispose();
  });

  it('drops the streaming write when the bubble splits into a continuation', async () => {
    const renderer = createRenderer();

    renderer.onTextDelta('drafting the file now');
    renderer.onToolProgress({
      toolName: 'write',
      elapsed: 0,
      contentTail: 'half a file',
      contentChars: 11,
      contentLines: 1,
    });
    await advance(500);
    expect(flushCallback.mock.calls.at(-1)?.[3]?.liveWrite).toBeTruthy();

    await renderer.sealForContinuation();

    expect(flushCallback.mock.calls.at(-1)?.[3]?.liveWrite).toBeNull();

    renderer.dispose();
  });

  it('keeps the round-trip cost on the timeline entry the card reads', async () => {
    const renderer = createRenderer();
    const usage = { step: 3, inputTokens: 3200, outputTokens: 326, contextTokens: 64000, contextWindow: 80000 };

    renderer.onToolStart('bash', { command: 'ls' }, 'call-1', usage);
    renderer.onToolStart('bash', { command: 'pwd' }, 'call-2');
    await advance(500);

    const timeline = flushCallback.mock.calls.at(-1)?.[3]?.timeline;
    expect(timeline?.[0]).toEqual(expect.objectContaining({ kind: 'tool', toolName: 'bash', usage }));
    expect(timeline?.[1]).not.toHaveProperty('usage');

    renderer.dispose();
  });

  describe('card-edit frequency limit', () => {
    const rejectedByFeishu = () =>
      Object.assign(new Error('This operation triggers the frequency limit'), {
        name: 'RateLimitError',
        code: 230020,
        retryable: true,
        retryAfterMs: 0,
      });

    /** Feishu's production cadence: one snapshot per second, 2s base penalty. */
    function createCadenceRenderer(
      flush: ReturnType<typeof vi.fn>,
      onFlushError = vi.fn(),
    ) {
      const renderer = new MessageRenderer({
        platformLimit: 4096,
        throttleMs: 1000,
        verboseLevel: 1,
        adaptiveFlush: {
          baseMs: 1000, minMs: 1000, maxMs: 1000, anchorToLastFlush: true, rateLimitBackoffMs: 2000,
        },
        onFlushError,
        flushCallback: flush as any,
      });
      return { renderer, onFlushError };
    }

    it('parks a rejected progress frame behind the penalty window', async () => {
      const flush = vi.fn()
        .mockImplementationOnce(() => Promise.resolve('msg-1'))
        .mockImplementationOnce(() => Promise.reject(rejectedByFeishu()))
        .mockImplementation(() => Promise.resolve());
      const { renderer, onFlushError } = createCadenceRenderer(flush);

      renderer.onToolStart('Bash');
      await advance(1100);
      expect(flush).toHaveBeenCalledTimes(1);

      renderer.onToolStart('Read');
      await advance(1100);
      // One attempt only: the doomed immediate re-send is what froze the card for 56s.
      expect(flush).toHaveBeenCalledTimes(2);
      expect(onFlushError).not.toHaveBeenCalled();

      await advance(1500);
      expect(flush).toHaveBeenCalledTimes(2);
      await advance(600);
      expect(flush).toHaveBeenCalledTimes(3);
      expect(onFlushError).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it('parks a rejected opening frame until the window closes', async () => {
      // The native path sends the first frame as an IM create, so a rejected create leaves
      // hasMessage false. That is exactly the input the hot loop used to hammer the API with.
      const flush = vi.fn().mockImplementation(() => Promise.reject(rejectedByFeishu()));
      const { renderer, onFlushError } = createCadenceRenderer(flush);

      renderer.onToolStart('Bash');
      await advance(1100);
      expect(flush).toHaveBeenCalledTimes(1);

      for (const step of [1000, 1000, 1000]) {
        renderer.onTextDelta('still growing');
        await advance(step);
      }
      // 2s penalty from the rejection, not one attempt per cadence tick.
      expect(flush).toHaveBeenCalledTimes(2);
      expect(onFlushError).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it('outlasts the penalty window to deliver the terminal frame', async () => {
      const flush = vi.fn()
        .mockImplementationOnce(() => Promise.resolve('msg-1'))
        .mockImplementation(() => Promise.resolve());
      const { renderer, onFlushError } = createCadenceRenderer(flush);

      renderer.onToolStart('Bash');
      await advance(1100);
      expect(flush).toHaveBeenCalledTimes(1);

      flush.mockImplementationOnce(() => Promise.reject(rejectedByFeishu()));
      const completed = renderer.onComplete();
      await advance(200);
      expect(flush).toHaveBeenCalledTimes(2);

      await advance(2000);
      expect(flush).toHaveBeenCalledTimes(3);
      expect(flush.mock.calls[2][0]).toBe(flush.mock.calls[1][0]);
      await completed;
      expect(renderer.messageId).toBe('msg-1');
      expect(onFlushError).not.toHaveBeenCalled();
      renderer.dispose();
    });

    it('tells the user once the terminal frame is rejected twice', async () => {
      const flush = vi.fn()
        .mockImplementationOnce(() => Promise.resolve('msg-1'))
        .mockImplementation(() => Promise.reject(rejectedByFeishu()));
      const { renderer, onFlushError } = createCadenceRenderer(flush);

      renderer.onToolStart('Bash');
      await advance(1100);
      const completed = renderer.onComplete();
      await advance(200);
      expect(flush).toHaveBeenCalledTimes(2);
      await advance(3500);
      await completed;

      expect(flush).toHaveBeenCalledTimes(3);
      expect(onFlushError).toHaveBeenCalledTimes(1);
      renderer.dispose();
    });
  });
});
