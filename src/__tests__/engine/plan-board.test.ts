import { describe, expect, it } from 'vitest';
import type { PlanTodo } from '../../shared/canonical/plan-signature.js';
import type { TodoStatus } from '../../shared/canonical/schema.js';
import { PlanBoard } from '../../server/engine/plan-board.js';

const plan = (content: string, status: TodoStatus = 'pending'): PlanTodo[] => [{ content, status }];

describe('PlanBoard', () => {
  it('reports only real changes', () => {
    const board = new PlanBoard();
    expect(board.update('s1', plan('a'))).toBe(true);
    expect(board.update('s1', plan('a'))).toBe(false);
    expect(board.update('s1', plan('a', 'completed'))).toBe(true);
    expect(board.current('s1')).toEqual([{ content: 'a', status: 'completed' }]);
  });

  it('keeps sessions apart', () => {
    const board = new PlanBoard();
    board.update('s1', plan('甲'));
    board.update('s2', plan('乙'));
    expect(board.current('s1')).toEqual([{ content: '甲', status: 'pending' }]);
    expect(board.current('s2')).toEqual([{ content: '乙', status: 'pending' }]);
  });

  it('treats a rotated session id — what /new produces — as an empty board', () => {
    const board = new PlanBoard();
    board.update('before-new', plan('a'));
    expect(board.current('after-new')).toEqual([]);
  });

  it('forgets a plan nobody refreshed within the ttl', () => {
    let now = 0;
    const board = new PlanBoard({ ttlMs: 1_000, now: () => now });
    board.update('s1', plan('a'));
    now = 1_500;
    expect(board.current('s1')).toEqual([]);
    // The expired entry is gone, so writing the same plan again counts as a change.
    expect(board.update('s1', plan('a'))).toBe(true);
  });

  it('evicts the least recently written session past the cap', () => {
    const board = new PlanBoard({ maxEntries: 2 });
    board.update('s1', plan('a'));
    board.update('s2', plan('b'));
    board.update('s1', plan('a', 'completed')); // rewrite refreshes recency
    board.update('s3', plan('c'));
    expect(board.current('s2')).toEqual([]);
    expect(board.current('s1')).toEqual([{ content: 'a', status: 'completed' }]);
    expect(board.current('s3')).toEqual([{ content: 'c', status: 'pending' }]);
  });

  it('refuses to share a plan when the conversation scope is missing', () => {
    const board = new PlanBoard();
    expect(board.update(undefined, plan('a'))).toBe(false);
    expect(board.update('', plan('a'))).toBe(false);
    expect(board.current(undefined)).toEqual([]);
    expect(board.current('')).toEqual([]);
  });

  it('treats an empty list as clearing that session plan', () => {
    const board = new PlanBoard();
    board.update('s1', plan('a'));
    expect(board.update('s1', [])).toBe(true);
    expect(board.current('s1')).toEqual([]);
    // Clearing an already empty board is not a change.
    expect(board.update('s1', [])).toBe(false);
  });
});
