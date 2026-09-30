import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';
import { classifyDefaultError, type BridgeError } from '../errors.js';
import type { InboundMessage } from '../types.js';
import { buildFeishuButtonElements, buildFeishuCard, type FeishuCardElement } from './card-builder.js';
import { configureFeishuCardBudget, getFeishuCardBudget } from './card-budget.js';
import { editFeishuMessage, sendFeishuMessage } from './sender.js';
import type { FeishuRenderedMessage } from './types.js';

/** Structural compatibility with ProgressData.timeline, including legacy result names. */
export interface FeishuToolDetailEntry {
  kind?: string;
  toolId?: string;
  toolName?: string;
  inputData?: unknown;
  toolInput?: string;
  input?: string;
  toolResult?: unknown;
  result?: unknown;
  status?: string;
  isError?: boolean;
}

export interface FeishuToolDetailsOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Cumulative retained UTF-8 data/offset/scope accounting, not a JS heap measurement. */
  maxBytes?: number;
  /** Both serialized card and API-envelope budgets; clamped to 3,000–16,000 bytes. */
  pageBytes?: number;
  maxSources?: number;
  maxPending?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
  classifyError?: (error: unknown) => BridgeError;
}

type DetailMessage = FeishuRenderedMessage & { flowDetailUserId?: string };
type Outcome = 'success' | 'failed' | 'interrupted' | 'returned';
interface Scope {
  chatId: string;
  threadId?: string;
  ownerUserId: string;
  replyToMessageId: string;
  replyInThread: boolean;
  receiveIdType?: string;
}
interface Snapshot {
  readonly id: string;
  readonly key: string;
  readonly chatId: string;
  readonly text: string;
  readonly outcome: Outcome;
  readonly expiresAt: number;
  bytes: number;
  scope?: Readonly<Scope>;
  sources: Set<string>;
  /** UTF-16 offsets are always at Unicode code-point boundaries; no copied page bodies. */
  pages?: ReadonlyArray<readonly [number, number]>;
  detail?: { messageId: string; page: number; state: 'open' | 'placeholder' | 'deleted' };
  tail: Promise<void>;
  pending: number;
}
interface Action {
  verb: 'open' | 'page' | 'close';
  id: string;
  page?: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ACTION = new RegExp(`^flow_detail:(open|page|close):(${UUID})(?::(0|[1-9][0-9]{0,8}))?$`);
const EXPIRED = '详情快照已过期或服务已重启；内存快照不可恢复，请查看原工具结果。';
const DENIED = '无权操作此详情，或卡片的聊天、话题、来源消息不匹配。';

function toast(type: 'success' | 'error', content: string): Record<string, unknown> {
  return { toast: { type, content } };
}

function parseAction(value: string): Action | undefined {
  const match = ACTION.exec(value);
  if (!match) return undefined;
  const verb = match[1] as Action['verb'];
  if ((verb === 'page') !== (match[3] !== undefined)) return undefined;
  return { verb, id: match[2], page: match[3] === undefined ? undefined : Number(match[3]) };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Canonical serialization for identity; rejects cycles/non-JSON data rather than inventing it. */
function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error('Snapshot nesting exceeds limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) {
      throw new Error('Snapshot must be finite JSON data');
    }
    ancestors.add(item);
    const result = Array.isArray(item)
      ? item.map((child) => normalize(child, depth + 1))
      : Object.fromEntries(
          Object.keys(item).sort().filter((key) => (item as Record<string, unknown>)[key] !== undefined)
            .map((key) => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]),
        );
    ancestors.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value, 0));
}

function stringField(data: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    if (typeof data[name] === 'string') return data[name] as string;
  }
  return undefined;
}

function editSections(input: unknown): string[] {
  const sections: string[] = [];
  const visit = (value: unknown, parentPath?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentPath);
      return;
    }
    const data = object(value);
    if (!data) return;
    const path = stringField(data, ['file_path', 'path', 'filePath']) ?? parentPath;
    const oldText = stringField(data, ['old_string', 'oldText', 'old_text', 'oldString']);
    const newText = stringField(data, ['new_string', 'newText', 'new_text', 'newString']);
    const content = stringField(data, ['content', 'file_content', 'fileContent', 'file content']);
    if (oldText !== undefined || newText !== undefined) {
      sections.push(
        `文件：${path ?? '未提供文件路径'}\n本次改动（替换片段）\n` +
        '未提供旧文件全文；以下仅为本次替换片段，不是完整文件差异。\n' +
        `替换前：\n${oldText ?? '（未提供旧片段）'}\n替换后：\n${newText ?? '（未提供新片段）'}`,
      );
    } else if (content !== undefined) {
      sections.push(
        `文件：${path ?? '未提供文件路径'}\n本次新增／写入内容：\n${content}\n` +
        '这是本次工具输入内容；不据此断言文件此前不存在，也不展示完整文件差异。',
      );
    }
    for (const name of ['edits', 'changes', 'files', 'replacements']) {
      if (Array.isArray(data[name])) visit(data[name], path);
    }
  };
  visit(input);
  return sections;
}

function outcome(entry: FeishuToolDetailEntry): Outcome | undefined {
  const status = entry.status?.toLowerCase();
  if (['running', 'pending', 'queued', 'started', 'waiting'].includes(status ?? '')) return undefined;
  if (entry.isError || ['failed', 'error'].includes(status ?? '')) return 'failed';
  if (['interrupted', 'cancelled', 'canceled', 'aborted'].includes(status ?? '')) return 'interrupted';
  if (entry.isError === false || ['completed', 'success', 'succeeded', 'done'].includes(status ?? '')) {
    return 'success';
  }
  return 'returned';
}

function validIdentifier(value: string | undefined): value is string {
  return !!value && Buffer.byteLength(value, 'utf8') <= 512;
}

function openIds(message: DetailMessage): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const action = parseAction(value);
    if (action?.verb === 'open') ids.add(action.id);
  };
  for (const button of [...(message.feishuButtons ?? []), ...(message.buttons ?? [])]) {
    if (!button.url) add(button.callbackData);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = object(value);
    if (!item) return;
    if (item.tag === 'button') {
      add(object(item.value)?.action);
      if (Array.isArray(item.behaviors)) {
        for (const behavior of item.behaviors) {
          const data = object(behavior);
          if (data?.type === 'callback') add(object(data.value)?.action);
        }
      }
    }
    for (const name of ['elements', 'columns', 'actions', 'body']) visit(item[name]);
  };
  visit(message.feishuElements);
  return ids;
}

/**
 * In-memory, owner-bound snapshots. No filesystem access and no model/query dispatch.
 * Call handle before the ordinary callback router; ANY non-undefined result is consumed.
 */
export class FeishuToolDetails {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly keys = new Map<string, string>();
  private readonly now: () => number;
  private readonly classifyError: (error: unknown) => BridgeError;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly pageBytes: number;
  private readonly maxSources: number;
  private readonly maxPending: number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private retainedBytes = 0;
  private disposed = false;

  constructor(options: FeishuToolDetailsOptions = {}) {
    const positive = (value: number | undefined, fallback: number): number =>
      value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    this.now = options.now ?? Date.now;
    this.classifyError = options.classifyError ?? classifyDefaultError;
    this.ttlMs = positive(options.ttlMs, 30 * 60_000);
    this.maxEntries = positive(options.maxEntries, 128);
    this.maxBytes = positive(options.maxBytes, 8 * 1024 * 1024);
    this.pageBytes = Math.max(3000, Math.min(16_000, positive(options.pageBytes, 16_000)));
    this.maxSources = Math.min(64, positive(options.maxSources, 32));
    this.maxPending = Math.min(32, positive(options.maxPending, 16));
    if (options.cleanupIntervalMs !== 0) {
      this.timer = setInterval(() => this.prune(),
        Math.min(this.ttlMs, positive(options.cleanupIntervalMs, 60_000)));
      this.timer.unref();
    }
  }

  /** Read-only operational counters; no snapshot content is exposed. */
  get stats(): Readonly<{ entries: number; bytes: number }> {
    this.prune();
    return { entries: this.snapshots.size, bytes: this.retainedBytes };
  }

  register(chatId: string, entry: FeishuToolDetailEntry): string | undefined {
    this.prune();
    if (this.disposed || !validIdentifier(chatId) || !validIdentifier(entry.toolId)) return undefined;
    const result = entry.toolResult !== undefined ? entry.toolResult : entry.result;
    const state = outcome(entry);
    // A completed flag alone is NOT a completed result snapshot. Empty string/null are real results.
    if (result === undefined || state === undefined || (entry.kind && entry.kind !== 'tool')) {
      return undefined;
    }
    try {
      let input = entry.inputData;
      if (input === undefined) {
        const raw = entry.toolInput ?? entry.input;
        if (!raw) return undefined;
        input = JSON.parse(raw);
      }
      const serialized = canonicalJson({
        chatId, toolId: entry.toolId, toolName: entry.toolName ?? '', input, result,
        outcome: state, status: entry.status ?? '',
      });
      if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) return undefined;
      const key = createHash('sha256').update(serialized).digest('hex');
      const existing = this.keys.get(key);
      if (existing) return existing; // Rendering repeatedly must not renew TTL or allocate snapshots.
      // Clone via JSON first. Mutating the caller's input/results cannot change these strings.
      const cloned = JSON.parse(serialized) as { input: unknown; result: unknown; toolName: string };
      const sections = editSections(cloned.input);
      if (sections.length === 0) return undefined;
      const labels: Record<Outcome, string> = {
        success: '工具执行成功 · 本次输入／结果快照',
        failed: '工具执行失败 · 输入／错误结果快照（不代表改动成功）',
        interrupted: '工具执行中断 · 输入／结果快照（不代表改动完成）',
        returned: '工具结果已返回 · 执行状态未提供（不据此断言成功）',
      };
      const resultText = typeof cloned.result === 'string'
        ? cloned.result : JSON.stringify(cloned.result, null, 2);
      const text = redactSensitiveContent(
        `${labels[state]}\n工具：${cloned.toolName}\n\n${sections.join('\n\n')}\n\n` +
        `工具输入快照（仅供核对）：\n${JSON.stringify(cloned.input, null, 2)}\n\n` +
        `工具结果快照：\n${resultText}`,
      );
      const id = randomUUID();
      const bytes = Buffer.byteLength(text + id + key + chatId, 'utf8') + 128;
      if (!this.reserve(bytes, true)) return undefined;
      const snapshot: Snapshot = {
        id, key, chatId, text, outcome: state, expiresAt: this.now() + this.ttlMs, bytes,
        sources: new Set(), tail: Promise.resolve(), pending: 0,
      };
      this.snapshots.set(id, snapshot);
      this.keys.set(key, id);
      this.retainedBytes += bytes;
      return id;
    } catch {
      return undefined;
    }
  }

  bind(message: DetailMessage, messageIds: string[]): void {
    this.prune();
    if (this.disposed || !validIdentifier(message.flowDetailUserId) ||
        !validIdentifier(message.chatId) ||
        (message.threadId !== undefined && !validIdentifier(message.threadId))) return;
    const sources = [...new Set(messageIds.filter(validIdentifier))].slice(0, this.maxSources);
    const replyToMessageId = message.replyToMessageId ?? sources[0];
    if (!validIdentifier(replyToMessageId) || sources.length === 0) return;
    if (message.threadId && message.replyInThread === false) return;
    const scope: Scope = {
      chatId: message.chatId, threadId: message.threadId,
      ownerUserId: message.flowDetailUserId, replyToMessageId,
      replyInThread: !!message.threadId || !!message.replyInThread,
      receiveIdType: message.receiveIdType,
    };
    for (const id of openIds(message)) {
      const snapshot = this.snapshots.get(id);
      if (!snapshot || snapshot.chatId !== message.chatId || snapshot.expiresAt <= this.now()) continue;
      if (snapshot.scope && canonicalJson(snapshot.scope) !== canonicalJson(scope)) continue;
      const nextSources = new Set([...snapshot.sources, ...sources].slice(0, this.maxSources));
      const pages = snapshot.pages ?? this.paginate(snapshot, scope);
      if (!pages) continue;
      const extra = Buffer.byteLength([...nextSources].filter((source) => !snapshot.sources.has(source)).join(''), 'utf8') +
        (snapshot.scope ? 0 : Buffer.byteLength(canonicalJson(scope), 'utf8') + pages.length * 16);
      if (!this.reserve(extra, false, snapshot.id)) continue;
      snapshot.scope ??= Object.freeze({ ...scope });
      snapshot.pages ??= pages;
      snapshot.sources = nextSources;
      snapshot.bytes += extra;
      this.retainedBytes += extra;
    }
  }

  async handle(
    message: InboundMessage, client: Client, authorized: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    const callback = message.callbackData;
    if (!callback?.startsWith('flow_detail:')) return undefined;
    // Consume malformed detail callbacks too: they must never fall through to the model.
    const action = parseAction(callback);
    if (!action) return toast('error', '无效的详情操作。');
    if (!authorized) return toast('error', DENIED);
    this.prune();
    const snapshot = this.snapshots.get(action.id);
    if (this.disposed || !snapshot || snapshot.expiresAt <= this.now()) return toast('error', EXPIRED);
    if (!this.permitted(snapshot, message, action)) return toast('error', DENIED);
    if (snapshot.pending >= this.maxPending) return toast('error', '详情正在处理，请稍后重试。');
    snapshot.pending++;
    const work = snapshot.tail.then(async () => {
      // Revalidate after waiting: a previous queued close/reopen may change the target.
      if (this.disposed || this.snapshots.get(action.id) !== snapshot ||
          snapshot.expiresAt <= this.now()) return toast('error', EXPIRED);
      if (!this.permitted(snapshot, message, action)) return toast('error', DENIED);
      try {
        return await this.perform(snapshot, action, client);
      } catch {
        // Never leak SDK payloads (which may include content, tokens, or unrelated IDs) in toasts.
        return toast('error', action.verb === 'close'
          ? '详情关闭失败；撤回和已关闭占位更新均未成功，请重试。'
          : '详情操作失败，未确认完成；请重试。');
      }
    });
    snapshot.tail = work.then(() => undefined, () => undefined);
    try {
      return await work;
    } finally {
      snapshot.pending--;
      this.prune();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.snapshots.clear();
    this.keys.clear();
    this.retainedBytes = 0;
  }

  private permitted(snapshot: Snapshot, message: InboundMessage, action: Action): boolean {
    const scope = snapshot.scope;
    if (!scope || !snapshot.pages || message.channelType !== 'feishu' ||
        message.chatId !== scope.chatId || message.threadId !== scope.threadId ||
        message.userId !== scope.ownerUserId || !message.messageId) return false;
    if (action.verb === 'open') return snapshot.sources.has(message.messageId);
    return message.messageId === snapshot.detail?.messageId;
  }

  private async perform(snapshot: Snapshot, action: Action, client: Client): Promise<Record<string, unknown>> {
    const scope = snapshot.scope!;
    const safeClient = checkedClient(client, scope);
    const detail = snapshot.detail;
    if (action.verb === 'open') {
      if (detail?.state === 'open') return toast('success', '详情已打开，请查看原详情卡。');
      const card = this.card(snapshot, scope, 0, snapshot.pages!.length);
      if (detail?.state === 'placeholder') {
        await editFeishuMessage(safeClient, detail.messageId, card, this.classifyError);
        detail.state = 'open';
        detail.page = 0;
      } else {
        const result = await sendFeishuMessage(safeClient, card, this.classifyError);
        if (!result.success || !validIdentifier(result.messageId)) throw new Error('No confirmed detail message');
        snapshot.detail = { messageId: result.messageId, page: 0, state: 'open' };
        // Detail IDs have a fixed accounting allowance in each snapshot's base bytes.
      }
      return toast('success', '详情已打开。');
    }
    if (!detail) return toast('error', DENIED);
    if (action.verb === 'page') {
      const page = action.page!;
      if (detail.state !== 'open' || page >= snapshot.pages!.length) {
        return toast('error', '详情已关闭或页码无效，请从原卡片重新打开。');
      }
      if (detail.page !== page) {
        await editFeishuMessage(safeClient, detail.messageId,
          this.card(snapshot, scope, page, snapshot.pages!.length), this.classifyError);
        detail.page = page;
      }
      return toast('success', '详情页已更新。');
    }
    if (detail.state !== 'open') return toast('success', '详情已关闭。');
    try {
      const result = await client.im.message.delete({ path: { message_id: detail.messageId } });
      assertSdkSuccess(result);
      detail.state = 'deleted';
    } catch {
      const placeholder: FeishuRenderedMessage = {
        ...scopeRoute(scope), feishuHeader: { template: 'blue', title: '工具详情' },
        feishuElements: [plain('详情已关闭；可从原工具卡片重新打开。')],
      };
      await editFeishuMessage(safeClient, detail.messageId, placeholder, this.classifyError);
      detail.state = 'placeholder';
    }
    return toast('success', '详情已关闭。');
  }

  private card(snapshot: Snapshot, scope: Scope, page: number, total: number, content?: string): FeishuRenderedMessage {
    const bounds = snapshot.pages?.[page];
    const body = content ?? (bounds ? snapshot.text.slice(bounds[0], bounds[1]) : '');
    return {
      ...scopeRoute(scope),
      feishuHeader: { template: snapshot.outcome === 'failed' ? 'red' : 'blue', title: '工具编辑详情 · 快照' },
      // plain_text is intentional: arbitrary source code/fences/HTML/Markdown remain literal.
      feishuElements: [plain(`第 ${page + 1} / ${total} 页 · 只展示当前页 · 内容按原样文本显示`), plain(body)],
      feishuButtons: [
        ...(page > 0 ? [{ label: '上一页', callbackData: `flow_detail:page:${snapshot.id}:${page - 1}` }] : []),
        ...(page + 1 < total ? [{ label: '下一页', callbackData: `flow_detail:page:${snapshot.id}:${page + 1}` }] : []),
        { label: '关闭详情', callbackData: `flow_detail:close:${snapshot.id}`, style: 'danger' },
      ],
    };
  }

  private paginate(snapshot: Snapshot, scope: Scope): ReadonlyArray<readonly [number, number]> | undefined {
    const pages: Array<readonly [number, number]> = [];
    let start = 0;
    let end = 0;
    let size = 0;
    // Measure the worst page index and BOTH navigation buttons, not only the first page.
    const sample = this.card(snapshot, scope, 999_999_998, 999_999_999, '');
    const baseline = serializedBudget(sample);
    const available = this.pageBytes - baseline - 64;
    if (available < 32) return undefined;
    // Outer API content is a JSON string containing card JSON. Count its double escaping.
    for (const point of snapshot.text) {
      const cost = Buffer.byteLength(JSON.stringify(JSON.stringify(point)), 'utf8') - 6;
      if (end > start && size + cost > available) {
        pages.push(Object.freeze([start, end] as const));
        start = end;
        size = 0;
      }
      end += point.length;
      size += cost;
    }
    pages.push(Object.freeze([start, end] as const));
    // Verify actual final card and envelope for every page before retaining the page index.
    for (let index = 0; index < pages.length; index++) {
      const [from, to] = pages[index];
      if (serializedBudget(this.card(snapshot, scope, index, pages.length,
        snapshot.text.slice(from, to))) > this.pageBytes) return undefined;
    }
    return Object.freeze(pages);
  }

  private remove(snapshot: Snapshot): void {
    this.snapshots.delete(snapshot.id);
    this.keys.delete(snapshot.key);
    this.retainedBytes -= snapshot.bytes;
  }

  private prune(): void {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.pending === 0 && snapshot.expiresAt <= this.now()) this.remove(snapshot);
    }
  }

  private reserve(bytes: number, newEntry: boolean, protectedId?: string): boolean {
    if (bytes > this.maxBytes) return false;
    for (const snapshot of this.snapshots.values()) {
      if (this.retainedBytes + bytes <= this.maxBytes &&
          (!newEntry || this.snapshots.size < this.maxEntries)) break;
      if (snapshot.pending === 0 && snapshot.id !== protectedId) this.remove(snapshot);
    }
    return this.retainedBytes + bytes <= this.maxBytes &&
      (!newEntry || this.snapshots.size < this.maxEntries);
  }
}

function plain(content: string): FeishuCardElement {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

function scopeRoute(scope: Scope): FeishuRenderedMessage {
  return {
    chatId: scope.chatId, threadId: scope.threadId, receiveIdType: scope.receiveIdType,
    replyToMessageId: scope.replyToMessageId, replyInThread: scope.replyInThread,
  };
}

function serializedBudget(message: FeishuRenderedMessage): number {
  const content = buildFeishuCard({
    header: message.feishuHeader as Parameters<typeof buildFeishuCard>[0]['header'],
    elements: [...(message.feishuElements ?? []) as FeishuCardElement[], ...buildFeishuButtonElements(message.feishuButtons)],
  });
  const envelope = {
    path: { message_id: message.replyToMessageId }, params: { receive_id_type: message.receiveIdType ?? 'chat_id' },
    data: { receive_id: message.chatId, root_id: message.replyToMessageId, reply_in_thread: message.replyInThread,
      msg_type: 'interactive', content },
  };
  return Math.max(Buffer.byteLength(content, 'utf8'), Buffer.byteLength(JSON.stringify(envelope), 'utf8'));
}

function assertSdkSuccess(value: unknown): void {
  if (object(value)?.code !== 0) throw new Error('Feishu SDK did not confirm success');
}

/**
 * sender historically falls back from expired/unsupported thread replies into the chat.
 * This scoped facade forbids that fallback and checks SDK *resolved* errors for all writes.
 * It still uses the public send/edit functions and their shared capacity checks.
 */
function checkedClient(client: Client, scope: Scope): Client {
  type Write = (request: any) => Promise<unknown>;
  const wrap = (operation: 'create' | 'reply' | 'patch'): Write => async (request) => {
    if (operation === 'create' && (scope.replyInThread || request.data?.root_id !== scope.replyToMessageId)) {
      throw new Error('Refusing a detail send outside its bound reply route');
    }
    if (operation === 'reply' && (request.path?.message_id !== scope.replyToMessageId ||
        request.data?.reply_in_thread !== scope.replyInThread)) {
      throw new Error('Refusing a detail reply outside its bound route');
    }
    const result = await (client.im.message[operation] as Write)(request);
    assertSdkSuccess(result);
    const threadId = object(object(result)?.data)?.thread_id;
    if (operation === 'reply' && scope.threadId && threadId !== undefined && threadId !== scope.threadId) {
      throw new Error('Feishu returned a different detail thread');
    }
    return result;
  };
  const scopedClient = { im: { message: {
    create: wrap('create'), reply: wrap('reply'), patch: wrap('patch'),
    delete: async (request: any) => {
      const result = await client.im.message.delete(request);
      assertSdkSuccess(result);
      return result;
    },
  } } } as unknown as Client;
  configureFeishuCardBudget(scopedClient, getFeishuCardBudget(client));
  return scopedClient;
}
