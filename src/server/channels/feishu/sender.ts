import { randomUUID } from 'node:crypto';
import { FEISHU_SNAPSHOT_REFRESH_MS } from '../../../shared/feishu-card-config.js';
import {
  applyNativeCard,
  createNativeCardState,
  ensureNativeCard,
  hasNativeCardApi,
  prepareNativeCard,
  type NativeCardState,
} from './native-streaming.js';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { BridgeError } from '../errors.js';
import type { SendResult, ThreadStartResult } from '../types.js';
import { getFeishuUploadKey } from './buffers.js';
import type { CardObject, FeishuCardBudget, PlannedFeishuCard } from './card-budget.js';
import {
  assertFeishuCardBudget,
  checkedFeishuResult,
  getFeishuCardBudget,
  isFeishuCardLimitError,
  lowerFeishuCardBudget as lowerBudget,
  planFeishuCards,
} from './card-budget.js';
import type { FeishuCardElement } from './card-builder.js';
import { buildFeishuButtonElements, buildFeishuCard } from './card-builder.js';
import { downgradeHeadings, markdownToFeishu } from './markdown.js';
import type { FeishuRenderedMessage } from './types.js';
import { compactSubagentCard } from './subagent-budget.js';

interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string; thread_id?: string };
}

type ClassifyError = (err: unknown) => BridgeError;

interface DeliveredPage {
  uuid: string;
  messageId?: string;
  threadId?: string;
  native?: NativeCardState;
  nativeAttached?: boolean;
  lastSnapshotPatchAt?: number;
  // Only confirmed SDK successes may become the planner's sealed prefix.
  plan?: PlannedFeishuCard;
  /** Freeze an uncertain child-card create request until its UUID is acknowledged. */
  pendingSubagentPlan?: PlannedFeishuCard;
}

interface DeliveryState {
  pages: DeliveredPage[];
  budget: FeishuCardBudget;
  work: Promise<unknown>;
  pending: number;
  failed: boolean;
  lastUsed: number;
  titleUuid: string;
  titleMessageId?: string;
}

interface ClientDeliveryState {
  roots: Map<string, DeliveryState>;
  deliveries: Map<string, DeliveryState>;
  objects: WeakMap<object, DeliveryState>;
}

const deliveriesByClient = new WeakMap<object, ClientDeliveryState>();
const MAX_TRACKED_ROOTS = 256;
const DELIVERY_IDLE_TTL_MS = 30 * 60 * 1000;

/** Bound strong references without evicting queued or running work. Prefer completed
 * deliveries over partial failures, whose UUIDs are needed for a subsequent retry. */
function pruneDeliveries(states: ClientDeliveryState, protectedState?: DeliveryState): void {
  const tracked = new Set([...states.roots.values(), ...states.deliveries.values()]);
  const idle = [...tracked].filter((state) => state !== protectedState && state.pending === 0);
  idle.sort((a, b) => Number(a.failed) - Number(b.failed) || a.lastUsed - b.lastUsed);
  const remove = (state: DeliveryState): void => {
    for (const [key, value] of states.roots) if (value === state) states.roots.delete(key);
    for (const [key, value] of states.deliveries)
      if (value === state) states.deliveries.delete(key);
    tracked.delete(state);
  };
  for (const state of idle) {
    if (Date.now() - state.lastUsed >= DELIVERY_IDLE_TTL_MS) remove(state);
  }
  for (const state of idle) {
    if (tracked.size <= MAX_TRACKED_ROOTS) break;
    if (tracked.has(state)) remove(state);
  }
}

function clientDeliveryState(client: Client): ClientDeliveryState {
  let state = deliveriesByClient.get(client);
  if (!state) {
    state = { roots: new Map(), deliveries: new Map(), objects: new WeakMap() };
    deliveriesByClient.set(client, state);
  }
  return state;
}

function newDeliveryState(client: Client): DeliveryState {
  return {
    pages: [],
    budget: getFeishuCardBudget(client),
    work: Promise.resolve(),
    pending: 0,
    failed: false,
    lastUsed: Date.now(),
    titleUuid: randomUUID(),
  };
}

function deliveryState(client: Client, identity: object, deliveryId?: string): DeliveryState {
  const states = clientDeliveryState(client);
  pruneDeliveries(states);
  let state =
    deliveryId === undefined ? states.objects.get(identity) : states.deliveries.get(deliveryId);
  if (!state) {
    state = newDeliveryState(client);
    if (deliveryId === undefined) states.objects.set(identity, state);
    else states.deliveries.set(deliveryId, state);
  }
  state.lastUsed = Date.now();
  pruneDeliveries(states, state);
  return state;
}

function rememberDelivery(client: Client, state: DeliveryState): void {
  const states = clientDeliveryState(client);
  for (const root of [state.titleMessageId, state.pages[0]?.messageId]) {
    if (!root) continue;
    states.roots.delete(root);
    states.roots.set(root, state);
  }
  state.lastUsed = Date.now();
  pruneDeliveries(states, state);
}

/** Includes the root and every individually confirmed overflow, even after partial failure. */
export function getFeishuMessageIds(client: Client, root: string): string[] {
  const state = clientDeliveryState(client).roots.get(root);
  return state
    ? [
        ...(root === state.titleMessageId ? [root] : []),
        ...state.pages.flatMap((page) => (page.messageId ? [page.messageId] : [])),
      ]
    : root
      ? [root]
      : [];
}

function serializeDelivery<T>(state: DeliveryState, action: () => Promise<T>): Promise<T> {
  // Count queued operations too: cache pressure must not split one active turn.
  state.pending++;
  const work = state.work
    .catch(() => undefined)
    .then(action)
    .then(
      (value) => {
        state.failed = false;
        return value;
      },
      (error: unknown) => {
        state.failed = true;
        throw error;
      },
    )
    .finally(() => {
      state.pending--;
      state.lastUsed = Date.now();
    });
  state.work = work;
  return work;
}

function errorCode(err: unknown): number {
  const e = err as { code?: unknown; response?: { data?: { code?: unknown } } };
  return Number(e?.response?.data?.code ?? e?.code);
}

function isMissingReplyTarget(err: unknown): boolean {
  return errorCode(err) === 230011 || errorCode(err) === 231003;
}

function isThreadReplyUnsupported(err: unknown): boolean {
  return errorCode(err) === 230071;
}

function cardForMessage(message: FeishuRenderedMessage): CardObject {
  const raw = message.text ? message.text : markdownToFeishu(message.html ?? '');
  const card = JSON.parse(
    message.feishuElements
      ? buildStructuredCardForMessage(message)
      : buildPlainCard(raw, message.feishuButtons ?? message.buttons, message.feishuHeader),
  );
  if (message.feishuStreaming && !message.feishuElements) {
    card.body.elements[0].element_id = 'stream_content';
  }
  return card;
}

function cardHasElement(content: string, elementId?: string): boolean {
  if (!elementId) return false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    const node = value as Record<string, unknown>;
    return node.element_id === elementId || Object.values(node).some(visit);
  };
  return visit(JSON.parse(content));
}

/** Every interactive SDK boundary checks the complete, final serialized card. */
async function patchCard(
  client: Client,
  messageId: string,
  content: string,
  budget: FeishuCardBudget,
  snapshotPage?: DeliveredPage,
): Promise<void> {
  assertFeishuCardBudget(content, budget);
  if (snapshotPage) {
    // IM card updates are limited to 5 QPS for each physical message. Protect
    // terminal/state transitions too, not only renderer text scheduling.
    const delay = snapshotPage.lastSnapshotPatchAt === undefined
      ? 0
      : Math.max(0, snapshotPage.lastSnapshotPatchAt + FEISHU_SNAPSHOT_REFRESH_MS - Date.now());
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    snapshotPage.lastSnapshotPatchAt = Date.now();
  }
  checkedFeishuResult(
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content },
    }),
  );
}

async function deliverCards(
  client: Client,
  state: DeliveryState,
  message: FeishuRenderedMessage,
  allowReplyFallback = true,
): Promise<string> {
  const useNative =
    hasNativeCardApi(client) &&
    (!!message.feishuStreaming || state.pages.some((page) => !!page.native));
  const prepared = useNative
    ? prepareNativeCard(cardForMessage(message), message.feishuStreaming?.elementIds ?? [])
    : undefined;
  const originalCard = prepared?.card ?? cardForMessage(message);
  const streamIds = prepared?.streamElementIds ?? [];
  let reductions = 0;
  let replanFrom = Number.POSITIVE_INFINITY;
  let failedIndex = 0;
  for (;;) {
    try {
      const previous = state.pages.flatMap((page, index) =>
        page.plan ? [{ ...page.plan, sealed: page.plan.sealed && index < replanFrom }] : [],
      );
      const card = message.feishuSubagentCard
        ? compactSubagentCard(originalCard, message.feishuSubagentCard.chunks, state.budget)
        : originalCard;
      const plans: PlannedFeishuCard[] = message.feishuSubagentCard
        ? [{ content: JSON.stringify(card), slices: [], sealed: false, budget: state.budget }]
        : planFeishuCards(card, state.budget, previous);
      // Empty sealed slots preserve indices in the middle, but a removed tail
      // must be withdrawn rather than kept as indefinitely blank overflow cards.
      while (plans.length > 1 && plans[plans.length - 1].slices.length === 0) plans.pop();
      if (message.feishuSingleCard && plans.length !== 1) {
        throw new Error('A detail navigation page cannot be split into multiple messages');
      }
      const lastStreamId = streamIds.at(-1);
      let activePageIndex = -1;
      plans.forEach((plan, index) => {
        if (
          (lastStreamId && plan.elementIds?.[lastStreamId]?.length) ||
          cardHasElement(plan.content, lastStreamId)
        )
          activePageIndex = index;
      });
      for (let index = 0; index < plans.length; index++) {
        failedIndex = index;
        const plan = plans[index];
        const page = state.pages[index] ?? { uuid: randomUUID() };
        // Persist the UUID before the request: retries after lost responses are idempotent.
        state.pages[index] = page;
        if (useNative) {
          page.native ??= createNativeCardState();
          const budget = plan.budget ?? state.budget;
          const pageStreamIds = streamIds.flatMap((id) => plan.elementIds?.[id] ?? []);
          // Validate the complete entity, not merely the tiny IM card-id reference.
          const cardId = await ensureNativeCard(
            client,
            page.native,
            plan.content,
            budget,
            pageStreamIds,
          );
          const reference = JSON.stringify({ type: 'card', data: { card_id: cardId } });
          if (!page.messageId) {
            const result = await sendMessageContent(
              client,
              message,
              'interactive',
              reference,
              page.uuid,
              budget,
              allowReplyFallback,
            );
            if (!result?.data?.message_id)
              throw new Error('Native card send returned no message_id');
            page.messageId = String(result.data.message_id);
            page.threadId = result.data.thread_id;
            page.nativeAttached = true;
            rememberDelivery(client, state);
          } else if (!page.nativeAttached) {
            // Recover a previously ordinary progress bubble in place, without a duplicate send.
            await patchCard(client, page.messageId, reference, budget);
            page.nativeAttached = true;
          }
          await applyNativeCard(
            client,
            page.native,
            plan.content,
            budget,
            pageStreamIds,
            !message.feishuStreaming?.enabled || index !== activePageIndex,
          );
        } else if (page.messageId) {
          if (page.plan?.content !== plan.content) {
            await patchCard(
              client, page.messageId, plan.content, plan.budget ?? state.budget,
              message.feishuSnapshot ? page : undefined,
            );
          }
        } else {
          // With a lost response, reusing a UUID with changed content can acknowledge
          // the old card while falsely committing the new text. Replay the exact create.
          const initial = message.feishuSubagentCard ? page.pendingSubagentPlan ?? plan : plan;
          if (message.feishuSubagentCard) page.pendingSubagentPlan = initial;
          const result = await sendMessageContent(
            client, message, 'interactive', initial.content, page.uuid,
            initial.budget ?? state.budget, allowReplyFallback,
          );
          const id = result?.data?.message_id;
          if (!id) throw new Error('Feishu card send returned no message_id');
          page.messageId = String(id);
          page.threadId = result.data?.thread_id;
          page.plan = initial;
          page.pendingSubagentPlan = undefined;
          rememberDelivery(client, state);
          if (initial.content !== plan.content) {
            await patchCard(client, page.messageId, plan.content, plan.budget ?? state.budget,
              message.feishuSnapshot ? page : undefined);
          }
        }
        page.plan = plan;
        rememberDelivery(client, state);
      }
      // Remove only acknowledged stale messages; failures retain their IDs for retry.
      for (let index = state.pages.length - 1; index >= plans.length; index--) {
        const page = state.pages[index];
        if (page.messageId) {
          if (page.native && page.plan) {
            await applyNativeCard(
              client,
              page.native,
              page.plan.content,
              page.plan.budget ?? state.budget,
              [],
              true,
            );
          }
          checkedFeishuResult(
            await client.im.message.delete({
              path: { message_id: page.messageId },
            }),
          );
        }
        state.pages.splice(index, 1);
        rememberDelivery(client, state);
      }
      return state.pages[0].messageId!;
    } catch (err) {
      // A planner envelope/continuation can itself exceed the final serialization
      // limit. Replan before touching the SDK, under the same bounded retry policy.
      const localLimit =
        err instanceof Error && err.message.startsWith('Feishu card cannot fit budget:');
      if ((!isFeishuCardLimitError(err) && !localLimit) || reductions >= 2) throw err;
      replanFrom = Math.min(replanFrom, failedIndex);
      if (message.feishuSubagentCard && state.pages[failedIndex]) {
        // A definite capacity rejection was not committed; this request may shrink.
        state.pages[failedIndex].pendingSubagentPlan = undefined;
      }
      state.budget = lowerBudget(state.budget);
      reductions++;
    }
  }
}

export async function sendFeishuMessage(
  client: Client,
  message: FeishuRenderedMessage,
  classifyError: ClassifyError,
): Promise<SendResult> {
  try {
    const state = deliveryState(client, message, message.deliveryId);
    return await serializeDelivery(state, async () => {
      if (message.media) {
        const page = state.pages[0] ?? { uuid: randomUUID() };
        state.pages[0] = page;
        if (!page.messageId) {
          const result = await sendMediaMessage(client, message, page.uuid);
          page.messageId = result.messageId;
          rememberDelivery(client, state);
        }
        return { messageId: page.messageId, success: true };
      }
      const messageId = await deliverCards(client, state, message);
      return { messageId, success: true };
    });
  } catch (err) {
    throw classifyError(err);
  }
}

export async function editFeishuMessage(
  client: Client | null,
  messageId: string,
  message: FeishuRenderedMessage,
  classifyError?: ClassifyError,
): Promise<void> {
  if (!client) return;
  const states = clientDeliveryState(client);
  pruneDeliveries(states);
  let state = states.roots.get(messageId);
  if (!state) {
    state = newDeliveryState(client);
    state.pages.push({ uuid: randomUUID(), messageId });
    rememberDelivery(client, state);
  }
  const target = state;
  try {
    await serializeDelivery(target, async () => {
      await deliverCards(client, target, message);
    });
  } catch (err) {
    throw classifyError ? classifyError(err) : err;
  }
}

type ThreadOptions = {
  chatId: string;
  messageId: string;
  text: string;
  autoPinTopics: boolean;
  classifyError: ClassifyError;
};

async function startThread(
  client: Client,
  options: ThreadOptions,
  state: DeliveryState,
): Promise<ThreadStartResult | null> {
  try {
    const replyMessageId = await deliverCards(
      client,
      state,
      {
        chatId: options.chatId,
        text: options.text,
        replyToMessageId: options.messageId,
        replyInThread: true,
      },
      false,
    );
    const threadId = state.pages[0]?.threadId;
    if (!threadId) {
      console.warn(
        `[feishu] startThreadFromMessage returned no thread_id for chat=${options.chatId.slice(-8)}`,
      );
      return null;
    }
    if (options.autoPinTopics) {
      await pinFeishuMessage(client, replyMessageId).catch((pinErr) => {
        console.warn(`[feishu] auto pin topic failed (${errorCode(pinErr)})`);
      });
    }
    return { threadId, rootMessageId: options.messageId, messageId: replyMessageId };
  } catch (err) {
    if (isThreadReplyUnsupported(err) || isMissingReplyTarget(err)) return null;
    throw options.classifyError(err);
  }
}

export async function startFeishuThreadFromMessage(
  client: Client | null,
  options: ThreadOptions,
): Promise<ThreadStartResult | null> {
  if (!client) return null;
  const state = deliveryState(client, options);
  return serializeDelivery(state, () => startThread(client, options, state));
}

export async function startFeishuThreadWithTitle(
  client: Client | null,
  options: {
    chatId: string;
    title: string;
    text: string;
    autoPinTopics: boolean;
    classifyError: ClassifyError;
  },
): Promise<ThreadStartResult | null> {
  if (!client) return null;
  const state = deliveryState(client, options);
  return serializeDelivery(state, async () => {
    if (!state.titleMessageId) {
      try {
        const root = await sendMessageContent(
          client,
          { chatId: options.chatId },
          'text',
          JSON.stringify({ text: options.title }),
          state.titleUuid,
        );
        state.titleMessageId = root?.data?.message_id;
        rememberDelivery(client, state);
      } catch (err) {
        throw options.classifyError(err);
      }
    }
    if (!state.titleMessageId) return null;
    return startThread(client, { ...options, messageId: state.titleMessageId }, state);
  });
}

export async function publishFeishuTopicMetadata(
  client: Client | null,
  options: {
    rootMessageId: string;
    text: string;
    autoPinTopics: boolean;
    classifyError: ClassifyError;
  },
): Promise<string | null> {
  if (!client) return null;
  const state = deliveryState(client, options);
  return serializeDelivery(state, async () => {
    try {
      if (!state.titleMessageId) {
        const result = checkedFeishuResult(
          await client.im.message.reply({
            path: { message_id: options.rootMessageId },
            data: {
              msg_type: 'post',
              content: buildTopicMetadataPost(options.text),
              reply_in_thread: true,
              uuid: state.titleUuid,
            },
          }),
        ) as FeishuCreateMessageResult;
        state.titleMessageId = result?.data?.message_id;
      }
      if (!state.titleMessageId) return null;
      if (options.autoPinTopics) {
        await pinFeishuMessage(client, state.titleMessageId).catch((pinErr) => {
          console.warn(`[feishu] auto pin topic metadata failed (${errorCode(pinErr)})`);
        });
      }
      return state.titleMessageId;
    } catch (err) {
      throw options.classifyError(err);
    }
  });
}

function buildTopicMetadataPost(text: string): string {
  const marker = text.match(/tlive-topic:[A-Za-z0-9_-]+/)?.[0] ?? text;
  return JSON.stringify({
    zh_cn: {
      title: 'TLive 会话索引',
      content: [
        [{ tag: 'a', text: 'TLive 会话索引', href: `https://tlive.local/session#${marker}` }],
      ],
    },
  });
}

export async function pinFeishuMessage(client: Client | null, messageId: string): Promise<void> {
  if (!client) return;
  checkedFeishuResult(await client.im.pin.create({ data: { message_id: messageId } }));
}

export function shouldSplitFeishuProgressMessage(
  message: FeishuRenderedMessage,
  client?: Client,
): boolean {
  const card =
    message.feishuStreaming && (!client || hasNativeCardApi(client))
      ? prepareNativeCard(cardForMessage(message), message.feishuStreaming.elementIds).card
      : cardForMessage(message);
  return planFeishuCards(card, getFeishuCardBudget(client)).length > 1;
}

function buildStructuredCardForMessage(message: FeishuRenderedMessage): string {
  return buildFeishuCard({
    header: message.feishuHeader as any,
    elements: [
      ...(message.feishuElements as FeishuCardElement[]),
      ...buildFeishuButtonElements(message.feishuButtons ?? message.buttons),
    ],
  });
}

function buildPlainCard(
  text: string,
  buttons?: FeishuRenderedMessage['buttons'],
  header?: { template: string; title: string },
): string {
  const elements: FeishuCardElement[] = [
    { tag: 'markdown', content: downgradeHeadings(text) },
    ...buildFeishuButtonElements(buttons),
  ];
  return buildFeishuCard({ header: header as any, elements });
}

async function sendMediaMessage(
  client: Client,
  message: FeishuRenderedMessage,
  uuid: string,
): Promise<SendResult> {
  const media = message.media;
  if (!media) throw new Error('No media attachment');
  const buffer = await mediaBuffer(media);
  const image = media.type === 'image';
  const uploadResult = checkedFeishuResult(
    image
      ? await client.im.image.create({ data: { image_type: 'message', image: buffer as any } })
      : await client.im.file.create({
          data: { file_type: 'stream', file_name: media.filename || 'file', file: buffer as any },
        }),
  );
  const keyName = image ? 'image_key' : 'file_key';
  const key = getFeishuUploadKey(uploadResult, keyName);
  if (!key) throw new Error(`Feishu upload returned no ${keyName}`);
  const result = await sendMessageContent(
    client,
    message,
    image ? 'image' : 'file',
    JSON.stringify({ [keyName]: key }),
    uuid,
  );
  const id = result?.data?.message_id;
  if (!id) throw new Error('Feishu media send returned no message_id');
  return { messageId: String(id), success: true };
}

async function mediaBuffer(media: NonNullable<FeishuRenderedMessage['media']>): Promise<Buffer> {
  if (media.buffer) return media.buffer;
  if (media.url?.startsWith('data:')) return Buffer.from(media.url.split(',')[1], 'base64');
  if (media.url) {
    const resp = await fetch(media.url);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error('No media source');
}

async function sendMessageContent(
  client: Client,
  message: FeishuRenderedMessage,
  msgType: string,
  content: string,
  uuid: string,
  budget = getFeishuCardBudget(client),
  allowReplyFallback = true,
): Promise<FeishuCreateMessageResult> {
  if (msgType === 'interactive') assertFeishuCardBudget(content, budget);
  const idType = message.receiveIdType || 'chat_id';
  if (message.replyToMessageId && message.replyInThread) {
    try {
      return checkedFeishuResult(
        await client.im.message.reply({
          path: { message_id: message.replyToMessageId },
          data: { msg_type: msgType, content, reply_in_thread: true, uuid },
        }),
      ) as FeishuCreateMessageResult;
    } catch (replyErr) {
      if (
        !allowReplyFallback ||
        (!isThreadReplyUnsupported(replyErr) && !isMissingReplyTarget(replyErr))
      ) {
        throw replyErr;
      }
      console.warn(
        `[feishu] reply_in_thread failed (${errorCode(replyErr)}), falling back to chat send`,
      );
    }
  }
  const data: Record<string, unknown> = {
    receive_id: message.chatId,
    msg_type: msgType,
    content,
    uuid,
  };
  if (message.replyToMessageId) data.root_id = message.replyToMessageId;
  try {
    return checkedFeishuResult(
      await client.im.message.create({
        params: { receive_id_type: idType as any },
        data: data as any,
      }),
    ) as FeishuCreateMessageResult;
  } catch (createErr) {
    if (message.replyToMessageId && isMissingReplyTarget(createErr)) {
      const { root_id: _rootId, ...fallbackData } = data;
      return checkedFeishuResult(
        await client.im.message.create({
          params: { receive_id_type: idType as any },
          data: fallbackData as any,
        }),
      ) as FeishuCreateMessageResult;
    }
    throw createErr;
  }
}
