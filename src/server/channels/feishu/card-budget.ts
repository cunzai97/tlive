import { createHash } from 'node:crypto';
import { countMarkdownTables, MAX_TABLES_PER_CARD } from './markdown.js';

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
  return { ...((client && budgets.get(client)) || DEFAULT_FEISHU_CARD_BUDGET) };
}
export function lowerFeishuCardBudget(budget: FeishuCardBudget): FeishuCardBudget {
  return {
    maxBytes: Math.max(1, Math.floor(budget.maxBytes * 0.75)),
    maxElements: Math.max(1, Math.floor(budget.maxElements * 0.75)),
    maxTables: Math.max(1, budget.maxTables - 1),
  };
}

export interface CardMeasurement {
  bytes: number;
  requestBytes: number;
  elements: number;
  tables: number;
}
export function measureFeishuCard(card: string | unknown): CardMeasurement {
  const serialized = typeof card === 'string' ? card : JSON.stringify(card);
  const object = typeof card === 'string' ? JSON.parse(card) : card;
  let elements = 0;
  let tables = 0;
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.tag === 'string') elements++;
    if ((node.tag === 'markdown' || node.tag === 'lark_md') && typeof node.content === 'string') {
      // Pipes inside fenced code are not materialized tables.
      tables += countMarkdownTables(
        node.content.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, ''),
      );
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(object);
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    requestBytes: Buffer.byteLength(
      JSON.stringify({ type: 'card_json', data: serialized }),
      'utf8',
    ),
    elements,
    tables,
  };
}
export function fitsFeishuCard(card: string | unknown, budget = getFeishuCardBudget()): boolean {
  budget = resolveFeishuCardBudget(budget);
  const size = measureFeishuCard(card);
  return (
    Math.max(size.bytes, size.requestBytes) <= budget.maxBytes &&
    size.elements <= budget.maxElements &&
    size.tables <= budget.maxTables
  );
}
export function assertFeishuCardBudget(
  card: string | unknown,
  budget = getFeishuCardBudget(),
): void {
  if (!fitsFeishuCard(card, budget)) {
    throw new Error(`Feishu card cannot fit budget: ${JSON.stringify(measureFeishuCard(card))}`);
  }
}

/** SDK errors can be returned as fulfilled promises; always check before committing state. */
export function checkedFeishuResult<T>(result: T): T {
  const response = result as { code?: number | string; msg?: string; message?: string } | undefined;
  if (response?.code !== undefined && Number(response.code) !== 0) {
    const error = Object.assign(
      new Error(response.msg ?? response.message ?? `Feishu error ${response.code}`),
      response,
    );
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
  return /(?:card|table|element|component).*(?:size|number|count|byte|length).*(?:exceed|over.?limit|too (?:large|many))|(?:table|element|component).*(?:over.?limit|too many)|卡片.*(?:体积|大小|元素|组件).*超|表格.*(?:超限|数量.*超)/i.test(
    message,
  );
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
  /** Confirmed historical pages retain their validated budget on a tail-only retry. */
  budget?: FeishuCardBudget;
  content: string;
  /** Source component IDs to the actual IDs in this serialized physical card. */
  elementIds?: Record<string, string[]>;
  slices: CardSlice[];
  sealed: boolean;
}
interface Leaf {
  key: string;
  node: CardObject;
}
const CHILD_ARRAYS = new Set(['elements', 'columns', 'actions']);
function leafText(node: CardObject): string | undefined {
  if (typeof node.content === 'string') return node.content;
  if (typeof node.text?.content === 'string' && node.tag !== 'button') return node.text.content;
  return undefined;
}
function isMarkdown(node: CardObject): boolean {
  return node.tag === 'markdown' || node.tag === 'lark_md' || node.text?.tag === 'lark_md';
}
function childKey(
  parent: string,
  property: string,
  node: CardObject,
  index: number,
  siblings: CardObject[] = [],
): string {
  // Inserting an unrelated sibling must not change an acknowledged call's ownership.
  const occurrence = siblings
    .slice(0, index)
    .filter((sibling) => sibling.element_id === node.element_id).length;
  return `${parent}/${property}/${
    typeof node.element_id === 'string' ? `#${node.element_id}@${occurrence}` : index
  }`;
}
function leavesOf(card: CardObject): Leaf[] {
  const leaves: Leaf[] = [];
  const visit = (node: CardObject, key: string): void => {
    let hasChildren = false;
    const visitArrays = (object: CardObject, path: string): void => {
      for (const [property, value] of Object.entries(object)) {
        if (CHILD_ARRAYS.has(property) && Array.isArray(value)) {
          if (value.length) hasChildren = true;
          value.forEach((child, index) => {
            visit(child, childKey(path, property, child, index, value));
          });
        } else if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value as CardObject).tag
        ) {
          visitArrays(value as CardObject, `${path}/${property}`);
        }
      }
    };
    visitArrays(node, key);
    if (!hasChildren && typeof node.tag === 'string') leaves.push({ key, node });
  };
  // The card envelope (including its title) is shared; only body components are paginated.
  (card.body?.elements ?? card.elements ?? []).forEach((node: CardObject, index: number) => {
    visit(node, childKey('', 'elements', node, index, card.body?.elements ?? card.elements ?? []));
  });
  return leaves;
}
function safeOffset(text: string, offset: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uDC00-\uDFFF]/.test(text[offset]) &&
    /[\uD800-\uDBFF]/.test(text[offset - 1])
  )
    return offset - 1;
  return offset;
}

/** Synthetic fences/headers are added only for presentation; slices keep exact source offsets. */
function fenceAt(text: string, offset: number): string | undefined {
  let open: string | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/gm)) {
    if (match.index! + match[0].length > offset) break;
    if (!open) open = match[1] + match[2];
    else {
      const marker = open.match(/^(`{3,}|~{3,})/)![0];
      if (match[1][0] === marker[0] && match[1].length >= marker.length && !match[2].trim())
        open = undefined;
    }
  }
  return open;
}
function markdownOffset(text: string, offset: number): number {
  offset = safeOffset(text, offset);
  // A header and separator are an indivisible table preamble. Otherwise the
  // next card's separator silently becomes plain text and evades table counting.
  for (const match of text.matchAll(/^\|[^\n]*\|\n\|[-:| ]+\|(?:\n|$)/gm)) {
    if (match.index! >= offset) break;
    if (offset < match.index! + match[0].length) return match.index!;
  }
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', lineStart);
  if (
    /^ {0,3}(`{3,}|~{3,})/.test(text.slice(lineStart)) &&
    offset > lineStart &&
    (lineEnd < 0 || offset <= lineEnd)
  )
    return lineStart;
  return offset;
}
function markdownSlice(text: string, start: number, end: number): string {
  let prefix = '';
  const startFence = fenceAt(text, start);
  const endFence = fenceAt(text, end);
  if (startFence) prefix = `${startFence}\n`;
  if (!startFence && start > 0) {
    const before = text.slice(0, start);
    const last = [...before.matchAll(/^(\|[^\n]*\|)\n(\|[-:| ]+\|)\n/gm)].at(-1);
    if (last && /^\|[^\n]*(?:\n\|[^\n]*)*\n?$/.test(before.slice(last.index! + last[0].length))) {
      prefix = `${text[start - 1] !== '\n' ? '**表格行/单元格（续）**\n\n' : ''}${last[1]}\n${last[2]}\n`;
    }
  }
  const body = prefix + text.slice(start, end);
  // Insert repeated headers without trimming, filtering or rewriting source rows.
  let header = '';
  let rows = 0;
  let inCode = false;
  const lines = body.split(/(?<=\n)/);
  const rendered = lines
    .map((line, index) => {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inCode = !inCode;
      if (inCode) return line;
      if (/^\|[-:| ]+\|\n?$/.test(line) && index > 0 && /^\|/.test(lines[index - 1])) {
        header = lines[index - 1] + line;
        rows = 0;
        return line;
      }
      if (header && /^\|/.test(line)) {
        if (rows++ === 10) {
          rows = 1;
          return `\n${header}${line}`;
        }
      } else if (header) {
        header = '';
        rows = 0;
      }
      return line;
    })
    .join('');
  return rendered + (endFence ? `\n${endFence.match(/^(`{3,}|~{3,})/)![0]}` : '');
}

function renderCard(
  card: CardObject,
  slices: CardSlice[],
  page: number,
  continued: Set<string>,
  later: Set<string>,
  elementIds?: Record<string, string[]>,
): string {
  const sourceById = new Map<string, string>();
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
            const result = visit(child, childKey(path, property, child, index, value));
            return result ? [result] : [];
          });
          keptChildren ||= copy[property].length > 0;
        } else if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value as CardObject).tag
        ) {
          copy[property] = copyArrays(value as CardObject, `${path}/${property}`);
        }
      }
      return copy;
    };
    Object.assign(clone, copyArrays(node, key));
    if (hadChildren ? !keptChildren : !selected) return undefined;
    const text = leafText(node);
    if (selected && text !== undefined) {
      const content = selected
        .map((range) =>
          isMarkdown(node)
            ? markdownSlice(text, range.start, range.end)
            : text.slice(range.start, range.end),
        )
        .join('');
      if (typeof node.content === 'string') clone.content = content;
      else clone.text = { ...node.text, content };
    }
    if (node.tag === 'collapsible_panel') {
      if (continued.has(key) && clone.header?.title) {
        clone.header = {
          ...clone.header,
          title: { ...clone.header.title, content: `${clone.header.title.content}（续）` },
        };
      }
      if (node.expanded === true && later.has(key)) clone.expanded = false;
    }
    if (typeof node.element_id === 'string') {
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
      clone.element_id = `e${createHash('sha256').update(`${page}:${hash}`).digest('hex').slice(0, 19)}`;
      sourceById.set(clone.element_id, node.element_id);
    }
    return clone;
  };
  const elements = (card.body?.elements ?? card.elements ?? []).flatMap(
    (node: CardObject, index: number) => {
      const value = visit(
        node,
        childKey('', 'elements', node, index, card.body?.elements ?? card.elements ?? []),
      );
      return value ? [value] : [];
    },
  );
  const output = card.body ? { ...card, body: { ...card.body, elements } } : { ...card, elements };
  // Normalize nested text/header IDs without making IDs depend on unrelated positions.
  const occurrences = new Map<string, number>();
  const uniqueId = (id: string): string => {
    const ordinal = occurrences.get(id) ?? 0;
    occurrences.set(id, ordinal + 1);
    const normalized = `e${createHash('sha256').update(`${page}:${id}:${ordinal}`).digest('hex').slice(0, 19)}`;
    if (elementIds) {
      const source = sourceById.get(id) ?? id;
      elementIds[source] ??= [];
      elementIds[source].push(normalized);
    }
    return normalized;
  };
  const normalize = (value: any, path: string): any => {
    if (Array.isArray(value))
      return value.map((child, index) => normalize(child, `${path}/${index}`));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([property, child]) => [
        property,
        property === 'element_id' && typeof child === 'string'
          ? uniqueId(child)
          : normalize(child, `${path}/${property}`),
      ]),
    );
  };
  return JSON.stringify(normalize(output, ''));
}
function ancestors(slices: CardSlice[]): Set<string> {
  const keys = new Set<string>();
  for (const slice of slices) {
    let key = slice.key;
    while (key.includes('/')) {
      keys.add(key);
      key = key.slice(0, key.lastIndexOf('/'));
    }
  }
  return keys;
}

/** Pure preview. Callers persist each individual plan ONLY after its SDK operation succeeds.
 * Sealed card ownership is retained; growth/replacements refresh old status metadata and
 * put unowned suffixes on the active tail instead of globally repacking the history.
 */
export function planFeishuCards(
  card: CardObject,
  budget = getFeishuCardBudget(),
  previous: PlannedFeishuCard[] = [],
): PlannedFeishuCard[] {
  budget = resolveFeishuCardBudget(budget);
  const leaves = leavesOf(card);
  const byKey = new Map(leaves.map((leaf) => [leaf.key, leaf]));
  // A short trailing text block may acquire a parent group on the next tool event.
  // Its globally unique renderer ID still identifies the same source leaf.
  const byIdentity = new Map<string, Leaf[]>();
  const identity = (key: string): string => key.split('/').at(-1) ?? key;
  for (const leaf of leaves) {
    const id = identity(leaf.key);
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), leaf]);
  }
  previous = previous.map((page) => ({
    ...page,
    slices: page.slices.map((slice) => {
      if (byKey.has(slice.key)) return slice;
      const candidates = identity(slice.key).startsWith('#')
        ? byIdentity.get(identity(slice.key))
        : undefined;
      return candidates?.length === 1 ? { ...slice, key: candidates[0].key } : slice;
    }),
  }));
  const positions = new Map(leaves.map((leaf, index) => [leaf.key, index]));
  const sealed = previous.filter((page) => page.sealed);
  const owned = new Set(sealed.flatMap((page) => page.slices.map((slice) => slice.key)));
  let preserveCount = previous.findIndex((page) => !page.sealed);
  if (preserveCount < 0) preserveCount = previous.length;
  // Growth before a later acknowledged block cannot simply be appended after it.
  // Repack only the affected suffix; the earlier confirmed prefix stays in place.
  for (let page = 0; page < preserveCount; page++) {
    for (const slice of previous[page].slices) {
      const text = leafText(byKey.get(slice.key)?.node ?? {});
      const position = positions.get(slice.key) ?? -1;
      if (slice.text === undefined || text === undefined) continue;
      if (
        text.startsWith(slice.text) &&
        text.length > slice.text.length &&
        slice.end === slice.text.length &&
        leaves.slice(position + 1).some((leaf) => owned.has(leaf.key))
      ) {
        preserveCount = page;
        break;
      }
    }
  }
  for (let index = 0; index < leaves.length; index++) {
    if (owned.has(leaves[index].key)) continue;
    const nextOwned = leaves.slice(index + 1).find((leaf) => owned.has(leaf.key));
    if (!nextOwned) continue;
    const affected = previous.findIndex(
      (page) =>
        page.sealed &&
        page.slices.some(
          (slice) => (positions.get(slice.key) ?? -1) >= (positions.get(nextOwned.key) ?? 0),
        ),
    );
    if (affected >= 0) preserveCount = Math.min(preserveCount, affected);
  }
  const chunks: CardSlice[][] = [];
  const reserved: CardSlice[] = [];
  // Reserve continuation decorations before packing, not only at final rendering.
  const allAncestors = ancestors(leaves.map((leaf) => ({ key: leaf.key, start: 0, end: 0 })));
  // Leave room for final status/footer/header changes on already sent cards.
  const packingBudget = {
    ...budget,
    maxBytes: budget.maxBytes - Math.min(512, Math.floor(budget.maxBytes * 0.15)),
  };
  const fits = (slices: CardSlice[], page: number): boolean =>
    fitsFeishuCard(renderCard(card, slices, page, allAncestors, allAncestors), packingBudget);
  const pack = (ranges: CardSlice[], pageOffset: number): CardSlice[][] => {
    const result: CardSlice[][] = [];
    let current: CardSlice[] = [];
    for (const range of ranges) {
      const leaf = byKey.get(range.key)!;
      const text = leafText(leaf.node);
      let start = range.start;
      do {
        const candidate = { ...range, start };
        if (fits([...current, candidate], pageOffset + result.length)) {
          current.push(candidate);
          break;
        }
        // Prefer intact semantic components, tables and paragraphs before splitting a leaf.
        if (current.length) {
          result.push(current);
          current = [];
          continue;
        }
        if (text === undefined || start === range.end)
          throw new Error(`Unsplittable Feishu component ${range.key} exceeds card budget`);
        let lo = start;
        let hi = range.end;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          const end = isMarkdown(leaf.node) ? markdownOffset(text, mid) : safeOffset(text, mid);
          if (
            end > start &&
            fits([{ ...range, start, end, whole: false }], pageOffset + result.length)
          )
            lo = mid;
          else hi = mid - 1;
        }
        let end = isMarkdown(leaf.node) ? markdownOffset(text, lo) : safeOffset(text, lo);
        if (end <= start) throw new Error(`Feishu card envelope leaves no room for ${range.key}`);
        const part = text.slice(start, end);
        const boundary = Math.max(part.lastIndexOf('\n\n'), part.lastIndexOf('\n'));
        if (boundary > part.length / 2) {
          const preferred = isMarkdown(leaf.node)
            ? markdownOffset(text, start + boundary + 1)
            : start + boundary + 1;
          if (
            preferred > start &&
            fits([{ ...range, start, end: preferred, whole: false }], pageOffset + result.length)
          )
            end = preferred;
        }
        current.push({ ...range, start, end, whole: false });
        result.push(current);
        current = [];
        start = end;
      } while (start < range.end);
    }
    if (current.length) result.push(current);
    return result;
  };
  for (const old of previous.slice(0, preserveCount)) {
    if (!old.sealed) break;
    const ranges = old.slices.flatMap((slice) => {
      const leaf = byKey.get(slice.key);
      if (!leaf) return [];
      const text = leafText(leaf.node);
      if (text === undefined) return [slice];
      const replaced = slice.whole && slice.text !== undefined && !text.startsWith(slice.text);
      const start = Math.min(slice.start, text.length);
      const end = replaced ? text.length : Math.min(slice.end, text.length);
      if (end <= start && text.length > 0) return [];
      return [{ ...slice, start, end, text }];
    });
    if (!ranges.length) {
      chunks.push([]);
      continue;
    }
    // An enlarged status/container may exhaust the reserve. Replan from this slot,
    // never move just its suffix behind unrelated later text.
    if (
      !fitsFeishuCard(
        renderCard(card, ranges, chunks.length, allAncestors, allAncestors),
        old.budget ?? budget,
      )
    )
      break;
    chunks.push(ranges);
    reserved.push(...ranges);
  }
  // Newly materialized short gap blocks can belong between two acknowledged calls.
  // Put them beside their fully owned predecessor when that frozen slot has room,
  // rather than interleaving them with the later call's unowned continuation.
  const originallyOwned = new Set(reserved.map((slice) => slice.key));
  for (let index = 0; index < leaves.length; index++) {
    const leaf = leaves[index];
    if (originallyOwned.has(leaf.key) || reserved.some((slice) => slice.key === leaf.key)) continue;
    if (!leaves.slice(index + 1).some((later) => originallyOwned.has(later.key))) continue;
    const predecessor = leaves
      .slice(0, index)
      .reverse()
      .find((earlier) => reserved.some((slice) => slice.key === earlier.key));
    if (!predecessor) continue;
    const owned = reserved.filter((slice) => slice.key === predecessor.key);
    const predecessorText = leafText(predecessor.node);
    if (
      predecessorText !== undefined &&
      Math.max(...owned.map((slice) => slice.end)) < predecessorText.length
    )
      continue;
    let page = -1;
    for (let slot = chunks.length - 1; slot >= 0; slot--) {
      if (chunks[slot].some((slice) => slice.key === predecessor.key)) {
        page = slot;
        break;
      }
    }
    if (page < 0) continue;
    const text = leafText(leaf.node);
    const range: CardSlice = { key: leaf.key, start: 0, end: text?.length ?? 1, whole: true, text };
    const candidate = [...chunks[page], range];
    if (fitsFeishuCard(renderCard(card, candidate, page, allAncestors, allAncestors), budget)) {
      chunks[page] = candidate;
      reserved.push(range);
    }
  }
  const remaining: CardSlice[] = [];
  for (const leaf of leaves) {
    const text = leafText(leaf.node);
    const used = reserved
      .filter((range) => range.key === leaf.key)
      .sort((a, b) => a.start - b.start);
    if (text === undefined || text.length === 0) {
      if (!used.length)
        remaining.push({
          key: leaf.key,
          start: 0,
          end: text === undefined ? 1 : 0,
          whole: true,
          text,
        });
      continue;
    }
    let start = 0;
    for (const range of used) {
      if (start < range.start) remaining.push({ key: leaf.key, start, end: range.start, text });
      start = Math.max(start, range.end);
    }
    if (start < text.length)
      remaining.push({ key: leaf.key, start, end: text.length, whole: start === 0, text });
  }
  const prefixCount = chunks.length;
  chunks.push(...pack(remaining, prefixCount));
  if (!chunks.length) chunks.push([]);
  const result = chunks.map((slices, index) => {
    const elementIds: Record<string, string[]> = {};
    return {
      elementIds,
      budget: { ...(index < prefixCount ? (previous[index]?.budget ?? budget) : budget) },
      slices,
      sealed: index < prefixCount || index < chunks.length - 1,
      content: renderCard(
        card,
        slices,
        index,
        ancestors(chunks.slice(0, index).flat()),
        ancestors(chunks.slice(index + 1).flat()),
        elementIds,
      ),
    };
  });
  for (const plan of result) assertFeishuCardBudget(plan.content, plan.budget);
  return result;
}
