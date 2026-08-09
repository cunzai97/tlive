import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostTracker } from '../../server/engine/cost-tracker.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TL_COST_INPUT_PER_M;
    delete process.env.TL_COST_OUTPUT_PER_M;
  });

  it('tracks SDK cost when supplied and otherwise does not invent a price', () => {
    tracker.start();
    expect(tracker.finish({ input_tokens: 1000, output_tokens: 500, cost_usd: 0.12 }))
      .toMatchObject({
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.12,
        costEstimated: false,
      });

    tracker = new CostTracker();
    tracker.start();
    expect(tracker.finish({ input_tokens: 1000, output_tokens: 500 })).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0,
      costEstimated: false,
    });
  });

  it('can estimate cost only when explicit local rates are configured', () => {
    process.env.TL_COST_INPUT_PER_M = '3';
    process.env.TL_COST_OUTPUT_PER_M = '15';

    tracker.start();
    expect(tracker.finish({ input_tokens: 1000, output_tokens: 500 })).toMatchObject({
      costUsd: expect.any(Number),
      costEstimated: true,
    });
  });

  it('formats visible cost, token, cache, reasoning, and duration fields', () => {
    vi.useFakeTimers();
    tracker.start();
    vi.advanceTimersByTime(154_000);
    expect(CostTracker.format(
      tracker.finish({
        input_tokens: 12345,
        output_tokens: 8100,
        context_tokens: 20445,
        cost_usd: 0.08,
      }),
    )).toBe(
      '输入(未缓存) 12.3k / 输入(已缓存) 0 / 输出 8.1k / 当前上下文 20.4k | $0.08 | 2m 34s',
    );

    tracker = new CostTracker();
    tracker.start();
    vi.advanceTimersByTime(45_000);
    expect(CostTracker.format(
      tracker.finish({ input_tokens: 800, output_tokens: 200, context_tokens: 1000, cost_usd: 1.5 }),
    )).toBe(
      '输入(未缓存) 800 / 输入(已缓存) 0 / 输出 200 / 当前上下文 1.0k | $1.50 | 45s',
    );

    tracker = new CostTracker();
    tracker.start();
    const cached = CostTracker.format(tracker.finish({
      input_tokens: 403800,
      cached_input_tokens: 400000,
      output_tokens: 2700,
      reasoning_output_tokens: 900,
      context_tokens: 406500,
    }));
    expect(cached).toContain(
      '输入(未缓存) 3.8k / 输入(已缓存) 400.0k / 输出 2.7k / 推理 900 / 当前上下文 406.5k',
    );
    expect(cached).not.toContain('403.8k');
    expect(cached).not.toContain('$');
  });
});
