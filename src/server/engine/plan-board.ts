import type { PlanTodo } from '../../shared/canonical/plan-signature.js';

export interface PlanBoardOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface PlanEntry {
  items: PlanTodo[];
  shape: string;
  at: number;
}

/** Latest accepted plan per trusted conversation/session scope, not model-supplied identity. */
export class PlanBoard {
  private readonly entries = new Map<string, PlanEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: PlanBoardOptions = {}) {
    const positive = (value: number | undefined, fallback: number): number =>
      value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
    this.now = options.now ?? Date.now;
    this.ttlMs = positive(options.ttlMs, 60 * 60_000);
    this.maxEntries = positive(options.maxEntries, 256);
  }

  /** Missing scope is deliberately not shared between otherwise unrelated conversations. */
  update(sessionKey: string | undefined, items: PlanTodo[]): boolean {
    if (!sessionKey) return false;
    const now = this.now();
    const previous = this.entries.get(sessionKey);
    const shape = JSON.stringify(items);
    const changed = !previous || previous.at + this.ttlMs <= now || previous.shape !== shape;
    this.entries.delete(sessionKey);
    if (items.length === 0) return !!previous;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    // Refresh recency/TTL even when the provider reaffirms an unchanged plan.
    this.entries.set(sessionKey, { items: structuredClone(items), shape, at: now });
    return changed;
  }

  current(sessionKey: string | undefined): PlanTodo[] {
    if (!sessionKey) return [];
    const entry = this.entries.get(sessionKey);
    if (!entry) return [];
    if (entry.at + this.ttlMs <= this.now()) {
      this.entries.delete(sessionKey);
      return [];
    }
    return structuredClone(entry.items);
  }
}
