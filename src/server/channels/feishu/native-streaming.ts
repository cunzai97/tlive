import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import {
  DEFAULT_FEISHU_NATIVE_PRINT,
  type FeishuNativePrintSettings,
} from '../../../shared/feishu-card-config.js';
import {
  assertFeishuCardBudget,
  checkedFeishuResult,
  type CardObject,
  type FeishuCardBudget,
} from './card-budget.js';
import { codeBlockBody } from './card-elements.js';

const CHILD_ARRAYS = ['elements', 'columns', 'actions'] as const;
/** Per-entity serialization floor; a frame's ops land up to this far behind its flush tick. */
export const API_INTERVAL_MS = 120;
const STREAM_RENEW_MS = 9 * 60_000;
const printConfigs = new WeakMap<object, FeishuNativePrintSettings>();
export function configureNativePrintConfig(
  client: object,
  print: FeishuNativePrintSettings,
): void {
  printConfigs.set(client, { ...print });
}
function getNativePrintConfig(client?: object): FeishuNativePrintSettings {
  return { ...((client && printConfigs.get(client)) || DEFAULT_FEISHU_NATIVE_PRINT) };
}
type OperationKind = 'content' | 'patch' | 'update' | 'settings';
interface PendingOperation {
  kind: OperationKind;
  request: Record<string, any>;
  after: string;
  budget: FeishuCardBudget;
}
export interface NativeCardState {
  cardId?: string;
  sequence: number;
  appliedContent?: string;
  streaming: boolean;
  openedAt: number;
  lastApiAt: number;
  pending?: PendingOperation;
  work: Promise<unknown>;
}
export function createNativeCardState(): NativeCardState {
  return { sequence: 0, streaming: false, openedAt: 0, lastApiAt: 0, work: Promise.resolve() };
}
export function hasNativeCardApi(client: Client): boolean {
  return (
    !!client.cardkit?.v1?.card?.create &&
    !!client.cardkit.v1.card.update &&
    !!client.cardkit.v1.card.settings &&
    !!client.cardkit.v1.cardElement?.content &&
    !!client.cardkit.v1.cardElement.patch
  );
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function children(node: CardObject): Array<{ node: CardObject; path: string }> {
  return [
    ...CHILD_ARRAYS.flatMap((property) =>
      Array.isArray(node[property])
        ? node[property].map((child: CardObject, index: number) => ({
            node: child,
            path: `${property}/${index}`,
          }))
        : [],
    ),
    ...(Array.isArray(node.body?.elements)
      ? node.body.elements.map((child: CardObject, index: number) => ({
          node: child,
          path: `body/elements/${index}`,
        }))
      : []),
  ];
}
function refs(card: CardObject): Map<string, CardObject> {
  const result = new Map<string, CardObject>();
  const visit = (node: CardObject): void => {
    if (typeof node.element_id === 'string') {
      if (result.has(node.element_id)) throw new Error('Duplicate native component identity');
      result.set(node.element_id, node);
    }
    for (const child of children(node)) visit(child.node);
  };
  for (const node of card.body?.elements ?? []) visit(node);
  return result;
}
/** Prepare metadata before pagination so every byte and ID participates in the shared budget. */
export function prepareNativeCard(
  source: CardObject,
  streamElementIds: readonly string[],
  client?: object,
): {
  card: CardObject;
  streamElementIds: string[];
} {
  const card = clone(source);
  const counts = new Map<string, number>();
  const streamSources = new Set(streamElementIds);
  const mapped: string[] = [];
  const visit = (node: CardObject, path: string): void => {
    const sourceId = typeof node.element_id === 'string' ? node.element_id : undefined;
    const key = sourceId ?? path;
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    const id =
      sourceId && /^[a-zA-Z0-9_]{1,20}$/.test(sourceId) && occurrence === 0
        ? sourceId
        : `n${createHash('sha256').update(`${key}:${occurrence}`).digest('hex').slice(0, 19)}`;
    node.element_id = id;
    if (sourceId && streamSources.has(sourceId) && node.tag === 'markdown') mapped.push(id);
    for (const child of children(node)) visit(child.node, `${path}/${child.path}`);
  };
  (card.body?.elements ?? []).forEach((node: CardObject, index: number) => {
    visit(node, `body/${index}`);
  });
  const print = getNativePrintConfig(client);
  card.config = {
    ...card.config,
    update_multi: true,
    // false is one byte longer than true: budget the maximum lifecycle metadata.
    streaming_mode: false,
    streaming_config: {
      print_frequency_ms: { default: print.frequencyMs },
      print_step: { default: print.step },
      print_strategy: print.strategy,
    },
  };
  refs(card);
  return { card, streamElementIds: mapped };
}
function configured(card: CardObject, streaming: boolean): CardObject {
  const result = clone(card);
  result.config = { ...result.config, update_multi: true, streaming_mode: streaming };
  return result;
}
function serialize<T>(state: NativeCardState, action: () => Promise<T>): Promise<T> {
  const work = state.work.catch(() => undefined).then(action);
  state.work = work;
  return work;
}
async function throttle(state: NativeCardState): Promise<void> {
  const delay = API_INTERVAL_MS - (Date.now() - state.lastApiAt);
  if (state.lastApiAt && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}
function knownRejection(error: unknown): boolean {
  const value = error as { code?: unknown; response?: { data?: { code?: unknown } } };
  const code = value?.response?.data?.code ?? value?.code;
  return code !== undefined && Number.isFinite(Number(code)) && Number(code) !== 0;
}
/** Unknown transport failures retain the exact sequence/UUID/payload until replay is confirmed. */
async function runPending(client: Client, state: NativeCardState): Promise<void> {
  const operation = state.pending;
  if (!operation) return;
  assertFeishuCardBudget(operation.after, operation.budget);
  const requestBytes = Buffer.byteLength(JSON.stringify(operation.request.data), 'utf8');
  if (requestBytes > operation.budget.maxBytes) {
    // No request has been sent: allow the shared planner to retry a smaller suffix.
    state.pending = undefined;
    throw new Error(`Feishu card cannot fit budget: native request bytes=${requestBytes}`);
  }
  await throttle(state);
  try {
    const request = operation.request;
    let result: unknown;
    if (operation.kind === 'content')
      result = await client.cardkit.v1.cardElement.content(request as any);
    else if (operation.kind === 'patch')
      result = await client.cardkit.v1.cardElement.patch(request as any);
    else if (operation.kind === 'update')
      result = await client.cardkit.v1.card.update(request as any);
    else result = await client.cardkit.v1.card.settings(request as any);
    checkedFeishuResult(result);
    const wasStreaming = state.streaming;
    state.appliedContent = operation.after;
    state.streaming = !!JSON.parse(operation.after).config.streaming_mode;
    if (state.streaming && (!wasStreaming || operation.kind === 'settings'))
      state.openedAt = Date.now();
    state.pending = undefined;
  } catch (error) {
    if (knownRejection(error)) state.pending = undefined;
    throw error;
  } finally {
    state.lastApiAt = Date.now();
  }
}
async function operation(
  client: Client,
  state: NativeCardState,
  kind: OperationKind,
  data: Record<string, unknown>,
  after: CardObject,
  budget: FeishuCardBudget,
  elementId?: string,
): Promise<void> {
  const content = JSON.stringify(after);
  assertFeishuCardBudget(content, budget);
  if (state.pending) await runPending(client, state);
  state.pending = {
    kind,
    after: content,
    budget: { ...budget },
    request: {
      path: { card_id: state.cardId!, ...(elementId ? { element_id: elementId } : {}) },
      data: { ...data, sequence: ++state.sequence, uuid: randomUUID() },
    },
  };
  await runPending(client, state);
}
async function ensureImpl(
  client: Client,
  state: NativeCardState,
  targetContent: string,
  budget: FeishuCardBudget,
  streamElementIds: readonly string[],
): Promise<string> {
  assertFeishuCardBudget(targetContent, budget);
  if (state.pending) await runPending(client, state);
  if (state.cardId) return state.cardId;
  const shell = configured(JSON.parse(targetContent), true);
  const entries = refs(shell);
  for (const id of streamElementIds) {
    const node = entries.get(id);
    if (node?.tag === 'markdown') node.content = '';
  }
  const content = JSON.stringify(shell);
  assertFeishuCardBudget(content, budget);
  await throttle(state);
  try {
    const response = checkedFeishuResult(
      await client.cardkit.v1.card.create({ data: { type: 'card_json', data: content } }),
    );
    const id = response?.data?.card_id;
    if (!id) throw new Error('CardKit create returned no confirmed card_id');
    state.cardId = id;
    state.appliedContent = content;
    state.streaming = true;
    state.openedAt = Date.now();
    return id;
  } finally {
    state.lastApiAt = Date.now();
  }
}
/** Create only the shell; callers must attach its card_id to IM before applying text deltas. */
export function ensureNativeCard(
  client: Client,
  state: NativeCardState,
  targetContent: string,
  budget: FeishuCardBudget,
  streamElementIds: readonly string[],
): Promise<string> {
  return serialize(state, () => ensureImpl(client, state, targetContent, budget, streamElementIds));
}
function topology(card: CardObject): string {
  const nodeShape = (node: CardObject): unknown => ({
    id: node.element_id,
    tag: node.tag,
    children: children(node).map((child) => ({ path: child.path, node: nodeShape(child.node) })),
  });
  return JSON.stringify((card.body?.elements ?? []).map(nodeShape));
}
function envelope(card: CardObject): string {
  const value = clone(card);
  delete value.body.elements;
  delete value.config.streaming_mode;
  return JSON.stringify(value);
}
/**
 * Text grows by appending, so a plain prefix test keeps what the client already printed. An element
 * whose whole body is one code block breaks that: its closing fence moves with every delta. Re-fence
 * the held body instead of dropping it, or the client would wipe the text and reprint it.
 */
function acknowledgedPrefix(desired: unknown, acknowledged: unknown): string {
  if (typeof acknowledged !== 'string') return '';
  if (typeof desired !== 'string') return '';
  if (desired.startsWith(acknowledged)) return acknowledged;
  const wanted = codeBlockBody(desired);
  const held = codeBlockBody(acknowledged);
  return wanted && held && wanted.body.startsWith(held.body)
    ? `${wanted.fence}\n${held.body}\n${wanted.fence}`
    : '';
}
function attributes(node: CardObject): CardObject {
  const value = clone(node);
  for (const key of CHILD_ARRAYS) delete value[key];
  delete value.body;
  delete value.element_id;
  delete value.tag;
  return value;
}
async function setStreaming(
  client: Client,
  state: NativeCardState,
  enabled: boolean,
  budget: FeishuCardBudget,
): Promise<void> {
  const after = configured(JSON.parse(state.appliedContent!), enabled);
  await operation(
    client,
    state,
    'settings',
    { settings: JSON.stringify({ config: { streaming_mode: enabled } }) },
    after,
    budget,
  );
}
export function applyNativeCard(
  client: Client,
  state: NativeCardState,
  targetContent: string,
  budget: FeishuCardBudget,
  streamElementIds: readonly string[],
  finish: boolean,
): Promise<string> {
  return serialize(state, async () => {
    await ensureImpl(client, state, targetContent, budget, streamElementIds);
    const target = JSON.parse(targetContent) as CardObject;
    const ids = new Set(streamElementIds);
    const desiredRefs = refs(target);
    let current = JSON.parse(state.appliedContent!) as CardObject;
    let currentRefs = refs(current);
    const textChanged = streamElementIds.some(
      (id) => desiredRefs.get(id)?.content !== currentRefs.get(id)?.content,
    );
    if (
      (!finish || textChanged) &&
      (!state.streaming || Date.now() - state.openedAt >= STREAM_RENEW_MS)
    ) {
      await setStreaming(client, state, true, budget);
      current = JSON.parse(state.appliedContent!);
      currentRefs = refs(current);
    }
    // Structural transitions preserve acknowledged semantic prefixes, then print only their deltas.
    if (topology(current) !== topology(target) || envelope(current) !== envelope(target)) {
      const staged = configured(target, state.streaming);
      for (const id of streamElementIds) {
        const node = refs(staged).get(id);
        const prefix = currentRefs.get(id)?.content;
        if (node?.tag === 'markdown') node.content = acknowledgedPrefix(node.content, prefix);
      }
      await operation(
        client,
        state,
        'update',
        { card: { type: 'card_json', data: JSON.stringify(staged) } },
        staged,
        budget,
      );
    }
    for (const [id, desired] of desiredRefs) {
      current = JSON.parse(state.appliedContent!);
      const old = refs(current).get(id);
      if (!old) throw new Error('Native component missing after structural update');
      const desiredAttrs = attributes(desired);
      const oldAttrs = attributes(old);
      const streamText = ids.has(id) && desired.tag === 'markdown';
      const nextText = desiredAttrs.content;
      if (streamText) {
        delete desiredAttrs.content;
        delete oldAttrs.content;
      }
      if (JSON.stringify(desiredAttrs) !== JSON.stringify(oldAttrs)) {
        Object.assign(old, desiredAttrs);
        await operation(
          client,
          state,
          'patch',
          { partial_element: JSON.stringify(desiredAttrs) },
          current,
          budget,
          id,
        );
      }
      if (streamText && nextText !== refs(JSON.parse(state.appliedContent!)).get(id)?.content) {
        if (!state.streaming) await setStreaming(client, state, true, budget);
        const after = JSON.parse(state.appliedContent!);
        refs(after).get(id)!.content = nextText;
        await operation(client, state, 'content', { content: nextText }, after, budget, id);
      }
    }
    if (finish && state.streaming) await setStreaming(client, state, false, budget);
    return state.cardId!;
  });
}
