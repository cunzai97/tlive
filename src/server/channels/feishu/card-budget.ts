import { createHash } from 'node:crypto';
import { countMarkdownTables, MAX_TABLES_PER_CARD, splitLargeTables } from './markdown.js';

/** Soft limits apply to the final serialized card, not just its markdown. */
export interface FeishuCardBudget {
  maxBytes: number;
  maxElements: number;
  maxTables: number;
}
export const DEFAULT_FEISHU_CARD_BUDGET: Readonly<FeishuCardBudget> = {
  maxBytes: 24000,
  maxElements: 160,
  maxTables: MAX_TABLES_PER_CARD,
};
const budgets = new WeakMap<object, FeishuCardBudget>();
export function resolveFeishuCardBudget(value: Partial<FeishuCardBudget> = {}): FeishuCardBudget {
  const budget = { ...DEFAULT_FEISHU_CARD_BUDGET, ...value };
  for (const [name, number] of Object.entries(budget)) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid card budget ${name}`);
  }
  // The configurable soft limit may not disable the platform's hard component limit.
  budget.maxBytes = Math.min(28_000, budget.maxBytes);
  budget.maxElements = Math.min(190, budget.maxElements);
  budget.maxTables = Math.min(MAX_TABLES_PER_CARD, budget.maxTables);
  return budget;
}
export function configureFeishuCardBudget(client: object, value: Partial<FeishuCardBudget>): void {
  budgets.set(client, resolveFeishuCardBudget(value));
}
export function getFeishuCardBudget(client?: object): FeishuCardBudget {
  return { ...(client && budgets.get(client) || DEFAULT_FEISHU_CARD_BUDGET) };
}
export function lowerFeishuCardBudget(budget: FeishuCardBudget): FeishuCardBudget {
  return {
    maxBytes: Math.max(1, Math.floor(budget.maxBytes * 0.75)),
    maxElements: Math.max(1, Math.floor(budget.maxElements * 0.75)),
    maxTables: Math.max(1, budget.maxTables - 1),
  };
}

export interface CardMeasurement { bytes: number; requestBytes: number; elements: number; tables: number }
export function measureFeishuCard(card: string | unknown): CardMeasurement {
  const serialized = typeof card === 'string' ? card : JSON.stringify(card);
  const object = typeof card === 'string' ? JSON.parse(card) : card;
  let elements = 0;
  let tables = 0;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.tag === 'string') elements++;
    if (node.tag === 'markdown' && typeof node.content === 'string') {
      tables += countMarkdownTables(node.content);
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(object);
  return { bytes: Buffer.byteLength(serialized, 'utf8'),
    requestBytes: Buffer.byteLength(JSON.stringify({ type: 'card_json', data: serialized }), 'utf8'),
    elements, tables };
}
export function fitsFeishuCard(card: string | unknown, budget = getFeishuCardBudget()): boolean {
  const size = measureFeishuCard(card);
  return Math.max(size.bytes, size.requestBytes) <= budget.maxBytes && size.elements <= budget.maxElements && size.tables <= budget.maxTables;
}
export function assertFeishuCardBudget(card: string | unknown, budget = getFeishuCardBudget()): void {
  if (!fitsFeishuCard(card, budget)) {
    throw new Error(`Feishu card cannot fit budget: ${JSON.stringify(measureFeishuCard(card))}`);
  }
}

/** SDK errors can be returned as fulfilled promises; always check before committing state. */
export function checkedFeishuResult<T>(result: T): T {
  const response = result as { code?: number | string; msg?: string; message?: string } | undefined;
  if (response?.code !== undefined && Number(response.code) !== 0) {
    const error = Object.assign(new Error(response.msg ?? response.message ?? `Feishu error ${response.code}`), response);
    throw error;
  }
  return result;
}
export function isFeishuCardLimitError(error: unknown): boolean {
  const e = error as any;
  const data = e?.response?.data ?? e;
  const code = Number(data?.code ?? e?.code);
  if (code === 230025 || code === 200860 || code === 300305) return true;
  // 230099 also means invalid card syntax. Do NOT retry all format errors.
  const message = String(data?.msg ?? data?.message ?? e?.message ?? '');
  return /(?:card|table|element|component).*(?:size|number|count|byte|length).*(?:exceed|over.?limit|too (?:large|many))|(?:table|element|component).*(?:over.?limit|too many)|卡片.*(?:体积|大小|元素|组件).*超|表格.*(?:超限|数量.*超)/i.test(message);
}

export type CardObject = Record<string, any>;
export interface CardSlice {
  key: string;
  start: number;
  end: number;
  /** Atomic components and replacement status text must remain mutable on sealed cards. */
  text?: string;
  whole?: boolean;
}
export interface PlannedFeishuCard {
  content: string;
  slices: CardSlice[];
  sealed: boolean;
}
interface Leaf { key: string; node: CardObject }
const CHILD_ARRAYS = new Set(['elements', 'columns', 'actions']);
function childKey(parent: string, property: string, node: CardObject, index: number): string {
  return `${parent}/${property}/${typeof node.element_id === 'string' ? `#${node.element_id}` : index}`;
}
function leavesOf(card: CardObject): Leaf[] {
  const leaves: Leaf[] = [];
  const visit = (node: CardObject, key: string): void => {
    let hasChildren = false;
    const visitArrays = (object: CardObject, path: string): void => {
      for (const [property, value] of Object.entries(object)) {
        if (CHILD_ARRAYS.has(property) && Array.isArray(value)) {
          if (value.length) hasChildren = true;
          value.forEach((child, index) => visit(child, childKey(path, property, child, index)));
        } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value as CardObject).tag) {
          visitArrays(value as CardObject, `${path}/${property}`);
        }
      }
    };
    visitArrays(node, key);
    if (!hasChildren && typeof node.tag === 'string') leaves.push({ key, node });
  };
  // The card envelope (including its title) is shared; only body components are paginated.
  (card.body?.elements ?? []).forEach((node: CardObject, index: number) => visit(node, childKey('', 'elements', node, index)));
  return leaves;
}
function safeOffset(text: string, offset: number): number {
  if (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) return offset - 1;
  return offset;
}

/** Synthetic fences/headers are added only for presentation; slices keep exact source offsets. */
function markdownSlice(text: string, start: number, end: number): string {
  let prefix = '';
  let suffix = '';
  const fenceAt = (offset: number): string | undefined => {
    let open: string | undefined;
    for (const match of text.slice(0, offset).matchAll(/^\s*(`{3,}|~{3,})([^\n]*)\n?/gm)) {
      if (!open) open = match[1] + match[2];
      else if (match[1][0] === open[0]) open = undefined;
    }
    return open;
  };
  const startFence = fenceAt(start);
  const endFence = fenceAt(end);
  if (startFence) prefix = `${startFence}\n`;
  if (endFence) suffix = `\n${endFence.match(/^(`{3,}|~{3,})/)?.[0] ?? '```'}`;
  if (!startFence && start > 0) {
    // Continue a row-split table with its original header. Long rows are represented as
    // literal row continuations rather than dropping an oversized cell.
    const before = text.slice(0, start);
    const matches = [...before.matchAll(/^(\|[^\n]*\|)\n(\|[-:| ]+\|)\n/gm)];
    const last = matches.at(-1);
    if (last && /^\|[^\n]*(?:\n\|[^\n]*)*\n?$/.test(before.slice(last.index! + last[0].length))) {
      prefix = `${last[1]}\n${last[2]}\n`;
      if (text[start - 1] !== '\n') prefix = '**表格行/单元格（续）**\n\n';
    }
  }
  return prefix + splitLargeTables(text.slice(start, end)) + suffix;
}

function renderCard(card: CardObject, slices: CardSlice[], page: number, continued: Set<string>, later: Set<string>): string {
  const selections = new Map<string, CardSlice[]>();
  for (const slice of slices) {
    const ranges = selections.get(slice.key) ?? [];
    ranges.push(slice);
    selections.set(slice.key, ranges);
  }
  const visit = (node: CardObject, key: string): CardObject | undefined => {
    const selected = selections.get(key);
    const clone: CardObject = { ...node };
    let hadChildren = false;
    let keptChildren = false;
    const copyArrays = (object: CardObject, path: string): CardObject => {
      const copy: CardObject = { ...object };
      for (const [property, value] of Object.entries(object)) {
        if (CHILD_ARRAYS.has(property) && Array.isArray(value)) {
          hadChildren ||= value.length > 0;
          copy[property] = value.flatMap((child, index) => {
            const result = visit(child, childKey(path, property, child, index));
            return result ? [result] : [];
          });
          keptChildren ||= copy[property].length > 0;
        } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value as CardObject).tag) {
          copy[property] = copyArrays(value as CardObject, `${path}/${property}`);
        }
      }
      return copy;
    };
    Object.assign(clone, copyArrays(node, key));
    if (hadChildren ? !keptChildren : !selected) return undefined;
    if (selected && typeof node.content === 'string') {
      clone.content = selected.map((range) => node.tag === 'markdown'
        ? markdownSlice(node.content, range.start, range.end)
        : node.content.slice(range.start, range.end)).join('');
    }
    if (node.tag === 'collapsible_panel') {
      if (continued.has(key) && clone.header?.title) {
        clone.header = { ...clone.header, title: { ...clone.header.title, content: `${clone.header.title.content}（续）` } };
      }
      if (node.expanded === true && later.has(key)) clone.expanded = false;
    }
    if (typeof node.element_id === 'string') {
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
      clone.element_id = `e${createHash('sha256').update(`${page}:${hash}`).digest('hex').slice(0, 19)}`;
    }
    return clone;
  };
  return JSON.stringify({ ...card, body: { ...card.body, elements: (card.body?.elements ?? []).flatMap((node: CardObject, index: number) => {
    const value = visit(node, childKey('', 'elements', node, index));
    return value ? [value] : [];
  }) } });
}
function ancestors(slices: CardSlice[]): Set<string> {
  const keys = new Set<string>();
  for (const slice of slices) {
    let key = slice.key;
    while (key.includes('/')) { keys.add(key); key = key.slice(0, key.lastIndexOf('/')); }
  }
  return keys;
}

/** Pure preview. Callers persist each individual plan ONLY after its SDK operation succeeds.
 * Sealed card ownership is retained; growth/replacements refresh old status metadata and
 * put unowned suffixes on the active tail instead of globally repacking the history.
 */
export function planFeishuCards(card: CardObject, budget = getFeishuCardBudget(), previous: PlannedFeishuCard[] = []): PlannedFeishuCard[] {
  const leaves = leavesOf(card);
  const byKey = new Map(leaves.map((leaf) => [leaf.key, leaf]));
  const chunks: CardSlice[][] = [];
  const reserved: CardSlice[] = [];
  const fits = (slices: CardSlice[], page: number): boolean => fitsFeishuCard(renderCard(card, slices, page, ancestors(reserved), new Set()), budget);
  const pack = (ranges: CardSlice[], pageOffset: number): CardSlice[][] => {
    const result: CardSlice[][] = [];
    let current: CardSlice[] = [];
    for (const range of ranges) {
      const leaf = byKey.get(range.key)!;
      const text = typeof leaf.node.content === 'string' ? leaf.node.content : undefined;
      let start = range.start;
      do {
        const candidate = { ...range, start };
        if (fits([...current, candidate], pageOffset + result.length)) { current.push(candidate); break; }
        // Prefer intact semantic components, tables and paragraphs before splitting a leaf.
        if (current.length) { result.push(current); current = []; continue; }
        if (text === undefined || start === range.end) throw new Error(`Unsplittable Feishu component ${range.key} exceeds card budget`);
        let lo = start;
        let hi = range.end;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          const end = safeOffset(text, mid);
          if (end > start && fits([{ ...range, start, end, whole: false }], pageOffset + result.length)) lo = mid;
          else hi = mid - 1;
        }
        let end = safeOffset(text, lo);
        if (end <= start) throw new Error(`Feishu card envelope leaves no room for ${range.key}`);
        const part = text.slice(start, end);
        const boundary = Math.max(part.lastIndexOf('\n\n'), part.lastIndexOf('\n'));
        if (boundary > part.length / 2) end = start + boundary + 1;
        current.push({ ...range, start, end, whole: false });
        result.push(current); current = []; start = end;
      } while (start < range.end);
    }
    if (current.length) result.push(current);
    return result;
  };
  for (const old of previous) {
    if (!old.sealed) break;
    const ranges = old.slices.flatMap((slice) => {
      const leaf = byKey.get(slice.key);
      if (!leaf) return [];
      const text = typeof leaf.node.content === 'string' ? leaf.node.content : undefined;
      if (text === undefined) return [slice];
      const replaced = slice.whole && slice.text !== undefined && !text.startsWith(slice.text);
      const start = Math.min(slice.start, text.length);
      const end = replaced ? text.length : Math.min(slice.end, text.length);
      if (end <= start && text.length > 0) return [];
      return [{ ...slice, start, end, text }];
    });
    if (!ranges.length) continue;
    // A status/title replacement may enlarge a sealed card. Keep that card's first
    // fitting piece in place; the rest becomes an explicit continuation on the tail.
    const first = pack(ranges, chunks.length)[0];
    chunks.push(first);
    reserved.push(...first);
  }
  const remaining: CardSlice[] = [];
  for (const leaf of leaves) {
    const text = typeof leaf.node.content === 'string' ? leaf.node.content : undefined;
    const used = reserved.filter((range) => range.key === leaf.key).sort((a, b) => a.start - b.start);
    if (text === undefined || text.length === 0) {
      if (!used.length) remaining.push({ key: leaf.key, start: 0, end: text === undefined ? 1 : 0, whole: true, text });
      continue;
    }
    let start = 0;
    for (const range of used) {
      if (start < range.start) remaining.push({ key: leaf.key, start, end: range.start, text });
      start = Math.max(start, range.end);
    }
    if (start < text.length) remaining.push({ key: leaf.key, start, end: text.length, whole: start === 0, text });
  }
  const prefixCount = chunks.length;
  chunks.push(...pack(remaining, prefixCount));
  if (!chunks.length) chunks.push([]);
  const result = chunks.map((slices, index) => ({
    slices,
    sealed: index < prefixCount || index < chunks.length - 1,
    content: renderCard(card, slices, index, ancestors(chunks.slice(0, index).flat()), ancestors(chunks.slice(index + 1).flat())),
  }));
  for (const plan of result) assertFeishuCardBudget(plan.content, budget);
  return result;
}
