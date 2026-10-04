/**
 * Identities for card elements that only exist while the turn is running.
 *
 * The paginator freezes confirmed pages so streaming growth cannot reflow history. A running-only
 * element that gets frozen there stays on a card the user already read past — and because
 * replacement text stays mutable on sealed pages, it even keeps ticking. These ids let the budget
 * planner recognise them and hand each one to the newest card instead.
 */
import { flowElementId } from './tool-display.js';

export const PROGRESS_ELAPSED_ELEMENT_ID = flowElementId('progress', 'elapsed');
export const PLAN_BOARD_ELEMENT_ID = flowElementId('plan', 'board');
export const LIVE_WRITE_LINE_ELEMENT_ID = flowElementId('live', 'line');
export const LIVE_WRITE_BODY_ELEMENT_ID = flowElementId('live', 'body');

/** Ids of elements that must never be owned by a sealed page. */
const TRANSIENT_ELEMENT_IDS: ReadonlySet<string> = new Set([
  PROGRESS_ELAPSED_ELEMENT_ID,
  PLAN_BOARD_ELEMENT_ID,
  LIVE_WRITE_LINE_ELEMENT_ID,
  LIVE_WRITE_BODY_ELEMENT_ID,
]);

const transientSegment = (segment: string): boolean =>
  segment.startsWith('#') && TRANSIENT_ELEMENT_IDS.has(segment.slice(1).split('@')[0] ?? '');

/** True when the leaf itself, or a container it sits in, is a running-only element. */
export function isTransientLeafKey(key: string): boolean {
  return key.split('/').some(transientSegment);
}
