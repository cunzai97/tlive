export interface AdaptiveFlushOptions {
  baseMs?: number;
  minMs?: number;
  maxMs?: number;
  sizePenaltyStartBytes?: number;
  largeSizePenaltyStartBytes?: number;
  fastOutputCharsPerSec?: number;
  veryFastOutputCharsPerSec?: number;
  highLatencyMs?: number;
  rateLimitBackoffMs?: number;
  /** Count the interval from the previous request start, not from its completion. */
  anchorToLastFlush?: boolean;
}

interface NextDelayInput {
  fallbackMs: number;
  content: string;
  phase: string;
  hasMessage: boolean;
  lastFlushAt?: number;
}

const TEXT_RATE_WINDOW_MS = 2000;
/** Repeated rejections must not ladder indefinitely: a card this stale is better redrawn late. */
const MAX_RATE_LIMIT_BACKOFF_MS = 15_000;

export class AdaptiveFlushController {
  private readonly baseMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly sizePenaltyStartBytes: number;
  private readonly largeSizePenaltyStartBytes: number;
  private readonly fastOutputCharsPerSec: number;
  private readonly veryFastOutputCharsPerSec: number;
  private readonly highLatencyMs: number;
  private readonly rateLimitBackoffMs: number;
  private readonly anchorToLastFlush: boolean;
  private textHistory: Array<{ at: number; chars: number }> = [];
  private lastLatencyMs = 0;
  private rateLimitedUntil = 0;
  private rateLimitStreak = 0;

  constructor(options: AdaptiveFlushOptions = {}) {
    this.baseMs = options.baseMs ?? 800;
    this.minMs = options.minMs ?? 800;
    this.maxMs = options.maxMs ?? 4000;
    this.sizePenaltyStartBytes = options.sizePenaltyStartBytes ?? 10 * 1024;
    this.largeSizePenaltyStartBytes = options.largeSizePenaltyStartBytes ?? 20 * 1024;
    this.fastOutputCharsPerSec = options.fastOutputCharsPerSec ?? 240;
    this.veryFastOutputCharsPerSec = options.veryFastOutputCharsPerSec ?? 480;
    this.highLatencyMs = options.highLatencyMs ?? 600;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 2000;
    this.anchorToLastFlush = options.anchorToLastFlush ?? false;
  }

  recordTextDelta(chars: number, now = Date.now()): void {
    if (chars <= 0) return;
    this.textHistory.push({ at: now, chars });
    this.pruneTextHistory(now);
  }

  recordFlushLatency(latencyMs: number): void {
    this.lastLatencyMs = Math.max(0, latencyMs);
    // A delivered frame ended the incident: the next rejection starts the ladder over.
    this.rateLimitStreak = 0;
  }

  recordRateLimit(retryAfterMs?: number, now = Date.now()): void {
    const requested = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : this.rateLimitBackoffMs;
    // Rejections inside an open penalty window extend it geometrically. A fixed retry after the
    // same delay re-enters that window: Feishu rejected 14 of 14 such retries in one turn.
    this.rateLimitStreak = this.rateLimitedUntil > now ? this.rateLimitStreak + 1 : 1;
    const ladderMs = Math.min(
      MAX_RATE_LIMIT_BACKOFF_MS,
      this.rateLimitBackoffMs * 2 ** (this.rateLimitStreak - 1),
    );
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, now + Math.max(requested, ladderMs));
  }

  /** How much of the penalty window is still ahead; a terminal frame has to outlast all of it. */
  remainingRateLimitMs(now = Date.now()): number {
    return Math.max(0, this.rateLimitedUntil - now);
  }

  nextDelay(input: NextDelayInput, now = Date.now()): number {
    // The penalty window wins over every short-circuit below it. A rejected first frame leaves
    // hasMessage false, and returning 0 there re-flushes immediately into the same open window.
    if (this.rateLimitedUntil > now) {
      return Math.max(this.minMs, this.rateLimitedUntil - now);
    }
    if (!input.hasMessage) return 0;
    if (input.phase === 'waiting_permission') return 0;

    let delay = Math.max(this.baseMs, input.fallbackMs);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes >= this.sizePenaltyStartBytes) delay += 400;
    if (bytes >= this.largeSizePenaltyStartBytes) delay += 800;

    const charsPerSec = this.currentCharsPerSec(now);
    if (charsPerSec >= this.fastOutputCharsPerSec) delay += 400;
    if (charsPerSec >= this.veryFastOutputCharsPerSec) delay += 800;

    if (this.lastLatencyMs >= this.highLatencyMs) delay += 500;

    const interval = clamp(delay, this.minMs, this.maxMs);
    return this.anchorToLastFlush && input.lastFlushAt !== undefined
      ? Math.max(0, interval - (now - input.lastFlushAt))
      : interval;
  }

  private currentCharsPerSec(now: number): number {
    this.pruneTextHistory(now);
    if (this.textHistory.length === 0) return 0;
    const chars = this.textHistory.reduce((sum, entry) => sum + entry.chars, 0);
    return chars / (TEXT_RATE_WINDOW_MS / 1000);
  }

  private pruneTextHistory(now: number): void {
    const cutoff = now - TEXT_RATE_WINDOW_MS;
    while (this.textHistory.length > 0 && this.textHistory[0].at < cutoff) {
      this.textHistory.shift();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
