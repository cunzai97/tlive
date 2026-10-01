/**
 * Progressive, lossless Feishu session. The same checked multi-card sender owns
 * create/update/close; native CardKit printing is used when the SDK supports it.
 * This prevents a small element update from overflowing its cumulative card and
 * makes partially delivered continuations retryable without truncation.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import { classifyDefaultError, type BridgeError } from '../errors.js';
import { editFeishuMessage, getFeishuMessageIds, sendFeishuMessage } from './sender.js';
import type { FeishuRenderedMessage } from './types.js';

export interface FeishuStreamingOptions {
  client: Client;
  chatId: string;
  receiveIdType?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  header?: { template: string; title: string };
  throttleMs?: number;
  classifyError?: (error: unknown) => BridgeError;
}

export class FeishuStreamingSession {
  private readonly deliveryId = randomUUID();
  private readonly classifyError: (error: unknown) => BridgeError;
  private readonly throttleMs: number;
  private header?: { template: string; title: string };
  private messageId?: string;
  private lastContent = '';
  private lastUpdateTime = 0;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FeishuStreamingOptions) {
    this.header = options.header;
    this.classifyError = options.classifyError ?? classifyDefaultError;
    this.throttleMs = Math.max(0, options.throttleMs ?? 250);
  }

  get currentMessageId(): string | undefined {
    return this.messageId;
  }

  get messageIds(): string[] {
    return this.messageId ? getFeishuMessageIds(this.options.client, this.messageId) : [];
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(action);
    this.queue = operation;
    return operation;
  }

  private message(text: string, header = this.header, finish = false): FeishuRenderedMessage {
    return {
      chatId: this.options.chatId,
      receiveIdType: this.options.receiveIdType,
      replyToMessageId: this.options.replyToMessageId,
      replyInThread: this.options.replyInThread,
      deliveryId: this.deliveryId,
      feishuStreaming: { enabled: !finish, elementIds: ['stream_content'] },
      feishuHeader: header,
      text,
    };
  }

  /** A failed partial start keeps its logical identity and UUIDs for retry. */
  start(initialText = '正在思考…'): Promise<string> {
    return this.serialize(async () => {
      if (this.messageId) return this.messageId;
      if (this.closed) throw new Error('Feishu streaming session is closed');
      const result = await sendFeishuMessage(
        this.options.client,
        this.message(initialText),
        this.classifyError,
      );
      if (!result.success || !result.messageId) throw new Error('No confirmed streaming message');
      this.messageId = result.messageId;
      this.lastContent = initialText;
      this.lastUpdateTime = Date.now();
      return result.messageId;
    });
  }

  private async apply(text: string, header = this.header, finish = false): Promise<void> {
    if (!this.messageId) throw new Error('Feishu streaming session has not started');
    const delay = this.throttleMs - (Date.now() - this.lastUpdateTime);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await editFeishuMessage(
      this.options.client,
      this.messageId,
      this.message(text, header, finish),
      this.classifyError,
    );
    // Commit only after every page is confirmed; a failed update remains retryable.
    this.lastContent = text;
    this.header = header;
    this.lastUpdateTime = Date.now();
  }

  update(fullText: string): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new Error('Feishu streaming session is closed');
      if (!this.messageId) throw new Error('Feishu streaming session has not started');
      if (fullText !== this.lastContent) await this.apply(fullText);
    });
  }

  close(options?: {
    finalText?: string;
    header?: { template: string; title: string };
  }): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      if (!this.messageId) throw new Error('Feishu streaming session has not started');
      await this.apply(
        options?.finalText ?? this.lastContent,
        options?.header ?? this.header,
        true,
      );
      this.closed = true;
    });
  }
}
