import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter } from '../base.js';
import type {
  InboundMessage,
  PinnedTopicMetadata,
  SendResult,
  ThreadStartResult,
} from '../types.js';
import type { BridgeError } from '../errors.js';
import { RateLimitError, AuthError, PlatformError, FormatError } from '../errors.js';
import { FeishuStreamingSession } from './streaming.js';
import { hasNativeCardApi } from './native-streaming.js';
import { FeishuFormatter } from './formatter.js';
import { FEISHU_POLICY } from './policy.js';
import type { FeishuRenderedMessage } from './types.js';
import type { QuickButtonName } from '../../../shared/ui/buttons.js';
import { feishuMessageEventToInbound, type FeishuMessageReceiveEvent } from './inbound.js';
import { feishuCardActionToInbound, feishuMenuEventToInbound } from './events.js';
import { findPinnedFeishuTopicMetadata } from './topic-recovery.js';
import {
  editFeishuMessage,
  getFeishuMessageIds,
  pinFeishuMessage,
  publishFeishuTopicMetadata,
  sendFeishuMessage,
  shouldSplitFeishuProgressMessage,
  startFeishuThreadFromMessage,
  startFeishuThreadWithTitle,
} from './sender.js';
import { t } from '../../../shared/i18n/index.js';
import type { FeishuCardFlowSettings } from '../../../shared/feishu-card-config.js';
import { configureFeishuCardBudget } from './card-budget.js';
import { createDefaultToolDisplayRegistry } from './tool-display.js';
import { FeishuToolDetails } from './tool-details.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  allowedUsers: string[];
}

export interface FeishuAdapterOptions {
  cardFlow?: FeishuCardFlowSettings;
  doneButtons?: readonly QuickButtonName[];
  autoPinTopics?: boolean;
  botOpenId?: string;
  botName?: string;
}

export class FeishuAdapter extends BaseChannelAdapter<FeishuRenderedMessage> {
  readonly channelType = 'feishu' as const;
  protected readonly policy = FEISHU_POLICY;
  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private config: FeishuConfig;
  private messageQueue: InboundMessage[] = [];
  private autoPinTopics: boolean;
  private botOpenId?: string;
  private botName?: string;
  private configuredBotOpenId?: string;
  private configuredBotName?: string;
  private readonly options: FeishuAdapterOptions;
  private toolDetails!: FeishuToolDetails;

  constructor(config: FeishuConfig, options: FeishuAdapterOptions = {}) {
    super();
    this.config = config;
    this.autoPinTopics = options.autoPinTopics ?? false;
    this.configuredBotOpenId = options.botOpenId;
    this.configuredBotName = options.botName;
    this.options = options;
    this.configureFormatter();
  }

  async start(): Promise<void> {
    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    if (this.options.cardFlow) {
      configureFeishuCardBudget(this.client, {
        maxBytes: this.options.cardFlow.maxBytes,
        maxElements: this.options.cardFlow.maxElements,
      });
    }
    this.configureFormatter();
    await this.resolveBotIdentity();

    const eventDispatcher = new EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (event: FeishuMessageReceiveEvent) => {
        if (!this.client) return;
        const inbound = await feishuMessageEventToInbound(event, this.client, {
          botOpenId: this.botOpenId,
          botName: this.botName,
        });
        if (inbound) this.messageQueue.push(inbound);
      },
    });

    // Register card action handler for button callbacks and form submissions (schema 2.0 cards)
    eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        console.log('[feishu] card.action.trigger received');
        const result = feishuCardActionToInbound(data);
        if (result.missingAction) {
          console.warn('[feishu] card.action.trigger: no action value found');
        }
        if (result.message && this.client) {
          const detailResponse = await this.toolDetails.handle(
            result.message,
            this.client,
            this.isAuthorized(result.message.userId, result.message.chatId),
          );
          if (detailResponse !== undefined) return detailResponse;
          this.messageQueue.push(result.message);
        }
        return result.response;
      },
    } as any);

    eventDispatcher.register({
      'application.bot.menu_v6': async (data: unknown) => {
        const inbound = feishuMenuEventToInbound(data);
        if (!inbound) {
          console.warn(
            '[feishu] application.bot.menu_v6: unknown event key',
            (data as { event_key?: string })?.event_key,
          );
          return {};
        }
        this.messageQueue.push(inbound);
        return {};
      },
    } as any);

    // Use WebSocket long connection (no public callback URL needed)
    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({ eventDispatcher });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try {
        (this.wsClient as any).close?.();
      } catch {
        /* best effort */
      }
      this.wsClient = null;
    }
    this.client = null;
    this.toolDetails.dispose();
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  override async startThreadFromMessage(
    chatId: string,
    messageId: string,
    text?: string,
  ): Promise<ThreadStartResult | null> {
    const finalText = text ?? t('feishu.topicProcessing');
    return startFeishuThreadFromMessage(this.client, {
      chatId,
      messageId,
      text: finalText,
      autoPinTopics: this.autoPinTopics,
      classifyError: (err) => this.classifyError(err),
    });
  }

  override async startThreadWithTitle(
    chatId: string,
    title: string,
    text?: string,
  ): Promise<ThreadStartResult | null> {
    const finalText = text ?? t('feishu.topicContinue');
    return startFeishuThreadWithTitle(this.client, {
      chatId,
      title,
      text: finalText,
      autoPinTopics: this.autoPinTopics,
      classifyError: (err) => this.classifyError(err),
    });
  }

  override async findPinnedTopicMetadata(
    chatId: string,
    threadId: string,
  ): Promise<PinnedTopicMetadata | null> {
    return findPinnedFeishuTopicMetadata(this.client, chatId, threadId);
  }

  override async publishTopicMetadata(
    _chatId: string,
    rootMessageId: string,
    text: string,
  ): Promise<string | null> {
    return publishFeishuTopicMetadata(this.client, {
      rootMessageId,
      text,
      autoPinTopics: this.autoPinTopics,
      classifyError: (err) => this.classifyError(err),
    });
  }

  async send(message: FeishuRenderedMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Feishu client not started');
    const result = await sendFeishuMessage(this.client, message, (err) => this.classifyError(err));
    if (result.messageId) this.bindToolDetails(message, result.messageId);
    return result;
  }

  async pinMessage(messageId: string): Promise<void> {
    await pinFeishuMessage(this.client, messageId);
  }

  async deleteMessage(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.im.message.delete({ path: { message_id: messageId } });
    } catch {
      // Non-fatal
    }
  }

  async editMessage(
    _chatId: string,
    messageId: string,
    message: FeishuRenderedMessage,
  ): Promise<void> {
    try {
      await editFeishuMessage(this.client, messageId, message, (err) => this.classifyError(err));
    } finally {
      // Earlier pages may have succeeded even if an overflow operation failed.
      if (this.client) this.bindToolDetails(message, messageId);
    }
  }

  override usesNativeProgressStreaming(): boolean {
    return (
      this.options.cardFlow?.mode !== 'legacy' &&
      this.options.cardFlow?.nativeStreaming === true &&
      !!this.client &&
      hasNativeCardApi(this.client)
    );
  }

  createStreamingSession(
    chatId: string,
    receiveIdType?: string,
    replyToMessageId?: string,
    header?: { template: string; title: string },
    replyInThread?: boolean,
  ): FeishuStreamingSession | null {
    if (!this.client) return null;
    return new FeishuStreamingSession({
      client: this.client,
      chatId,
      receiveIdType,
      replyToMessageId,
      header,
      replyInThread,
      classifyError: (error) => this.classifyError(error),
    });
  }

  override shouldSplitProgressMessage(message: FeishuRenderedMessage): boolean {
    return shouldSplitFeishuProgressMessage(message, this.client ?? undefined);
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; reactions are used instead
    // (handled by bridge-manager via addReaction)
  }

  private reactionIds = new Map<string, string>();

  async addReaction(_chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      // Remove existing reaction first (if any)
      await this.removeReaction(_chatId, messageId);
      const result = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      const reactionId = (result as any)?.data?.reaction_id;
      if (reactionId) this.reactionIds.set(messageId, reactionId);
    } catch {
      /* non-fatal */
    }
  }

  async removeReaction(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    const reactionId = this.reactionIds.get(messageId);
    if (!reactionId) return;
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      this.reactionIds.delete(messageId);
    } catch {
      // Non-fatal
    }
  }

  validateConfig(): string | null {
    if (!this.config.appId) return 'TL_FS_APP_ID is required for Feishu';
    if (!this.config.appSecret) return 'TL_FS_APP_SECRET is required for Feishu';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    // userId may be user_id or open_id — match against either format in allowedUsers
    return this.config.allowedUsers.includes(userId);
  }

  // --- Error classification (OCP: platform-specific error handling) ---

  /** Classify Feishu/Lark SDK errors */
  classifyError(err: unknown): BridgeError {
    const e = err as Record<string, any>;
    const responseData = e?.response?.data as Record<string, any> | undefined;
    const message = responseData?.msg ?? e?.msg ?? e?.message ?? String(err);

    // Feishu uses numeric error codes
    const code = responseData?.code ?? e?.data?.code ?? e?.code;
    const statusCode =
      e?.statusCode ??
      e?.status ??
      e?.response?.statusCode ??
      e?.response?.status ??
      statusCodeFromMessage(message);
    if (code === 230020 || code === 99991400 || statusCode === 429) {
      return new RateLimitError(message, readRetryAfterMs(e));
    }
    if (code === 99991401 || code === 99991403) return new AuthError(message);
    if (
      code === 230099 ||
      code === 11310 ||
      /ErrCode:\s*11310|card table number over limit/i.test(message)
    ) {
      console.warn(
        `[feishu] FormatError (${code ?? '11310'}): message may be too large or contain too many tables. ${message}`,
      );
      return new FormatError(message); // card table number over limit or content too large
    }
    if (statusCode) return new PlatformError(message, statusCode);

    return super.classifyError(err);
  }

  /** Get Feishu bot info for display */
  getBotInfo(): { appId?: string; name?: string } {
    return { appId: this.config.appId, name: this.botName };
  }

  private configureFormatter(): void {
    this.toolDetails?.dispose();
    this.toolDetails = new FeishuToolDetails({
      pageBytes: this.options.cardFlow?.maxBytes,
      classifyError: (error) => this.classifyError(error),
    });
    const registry = createDefaultToolDisplayRegistry();
    for (const [name, category] of Object.entries(this.options.cardFlow?.toolRules ?? {})) {
      registry.register(name, category === 'edit' ? 'editing' : category);
    }
    this.formatter = new FeishuFormatter('zh', {
      nativeStreaming: this.options.cardFlow?.nativeStreaming ?? false,
      doneButtons: this.options.doneButtons,
      flowOptions: {
        mode: this.options.cardFlow?.mode ?? 'blocks',
        groupGapTokens: this.options.cardFlow?.groupGapTokens ?? 50,
        registry,
      },
      toolDetails: this.toolDetails,
    });
  }

  private bindToolDetails(message: FeishuRenderedMessage, root: string): void {
    if (!this.client) return;
    this.toolDetails.bind(message, getFeishuMessageIds(this.client, root));
  }

  private async resolveBotIdentity(): Promise<void> {
    this.botOpenId = this.configuredBotOpenId;
    this.botName = this.configuredBotName;
    if (this.botOpenId && this.botName) return;

    const info = await fetchFeishuBotInfo(this.config.appId, this.config.appSecret).catch((err) => {
      console.warn(`[feishu] failed to resolve bot info: ${String(err)}`);
      return null;
    });
    this.botOpenId ??= info?.openId;
    this.botName ??= info?.name;
  }
}

function readRetryAfterMs(err: Record<string, any>): number {
  const headers = err?.response?.headers ?? err?.headers ?? {};
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000;
}

function statusCodeFromMessage(message: string): number | undefined {
  const match = message.match(/status code\s+(\d{3})/i);
  if (!match) return undefined;
  const statusCode = Number(match[1]);
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

async function fetchFeishuBotInfo(
  appId: string,
  appSecret: string,
): Promise<{ openId?: string; name?: string }> {
  const tokenResult = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  ).then((res) => res.json() as Promise<Record<string, any>>);
  if (tokenResult.code !== 0 || !tokenResult.tenant_access_token) {
    throw new Error(tokenResult.msg || `tenant token error ${tokenResult.code}`);
  }

  const infoResult = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    headers: { authorization: `Bearer ${tokenResult.tenant_access_token}` },
  }).then((res) => res.json() as Promise<Record<string, any>>);
  if (infoResult.code !== 0) {
    throw new Error(infoResult.msg || `bot info error ${infoResult.code}`);
  }

  return {
    openId: typeof infoResult.bot?.open_id === 'string' ? infoResult.bot.open_id : undefined,
    name: typeof infoResult.bot?.app_name === 'string' ? infoResult.bot.app_name : undefined,
  };
}
