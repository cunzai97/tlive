/**
 * Feishu CardKit streaming session.
 * Creates a card with streaming_mode=true, sends element-level updates,
 * and closes streaming when complete.
 */

export interface FeishuStreamingOptions {
  client: any; // Lark SDK client
  chatId: string;
  receiveIdType?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  header?: { template: string; title: string };
}

export class FeishuStreamingSession {
  private client: any;
  private chatId: string;
  private receiveIdType: string;
  private replyToMessageId?: string;
  private replyInThread?: boolean;
  private header?: { template: string; title: string };
  private cardId?: string;
  private messageId?: string;
  private sequence = 0;
  private lastContent = '';
  private updateQueue: Promise<void> = Promise.resolve();
  private throttleMs = 250;
  private lastUpdateTime = 0;
  /**
   * 飞书 CardKit 流式更新的内容大小限制。
   * 实际限制约 27KB，保守设为 20KB 避免触发 230099 等格式错误。
   */
  private readonly MAX_STREAMING_CONTENT_BYTES = 20 * 1024;
  private readonly CONTINUATION_SUFFIX = '\n\n--- (内容继续中...) ---';

  constructor(options: FeishuStreamingOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.receiveIdType = options.receiveIdType || 'chat_id';
    this.replyToMessageId = options.replyToMessageId;
    this.replyInThread = options.replyInThread;
    this.header = options.header;
  }

  get currentMessageId(): string | undefined {
    return this.messageId;
  }

  /** Create card + send as message. Returns messageId. */
  async start(initialText = 'Thinking...'): Promise<string> {
    // Step 1: Create card entity with streaming enabled
    const cardJson: Record<string, unknown> = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: '[Generating...]' },
        streaming_config: {
          print_frequency_ms: { default: 120 },
          print_step: { default: 4 },
        },
      },
      body: {
        elements: [{ tag: 'markdown', content: initialText, element_id: 'content' }],
      },
    };

    if (this.header) {
      cardJson.header = {
        title: { tag: 'plain_text', content: this.header.title },
        template: this.header.template,
      };
    }

    const createResult = await this.client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardJson) },
    });
    this.cardId = (createResult as any)?.data?.card_id;
    if (!this.cardId) throw new Error('Failed to create streaming card');

    // Step 2: Send card as message
    const content = JSON.stringify({ type: 'card', data: { card_id: this.cardId } });
    let result: any;

    if (this.replyToMessageId) {
      try {
        result = await this.client.im.message.reply({
          path: { message_id: this.replyToMessageId },
          data: {
            msg_type: 'interactive',
            content,
            reply_in_thread: this.replyInThread || undefined,
          },
        });
      } catch (err) {
        const code = (err as any)?.code;
        if (code !== 230071 && code !== 230011 && code !== 231003) {
          throw err;
        }
      }
    }

    if (!result) {
      result = await this.client.im.message.create({
        params: { receive_id_type: this.receiveIdType },
        data: {
          receive_id: this.chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }

    this.messageId = result?.data?.message_id ?? '';
    return this.messageId!;
  }

  /** Update the streaming card content (cumulative text). Throttled + serialized. */
  async update(fullText: string): Promise<void> {
    if (!this.cardId || fullText === this.lastContent) return;
    this.lastContent = fullText;

    // Serialize updates to maintain sequence ordering
    this.updateQueue = this.updateQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastUpdateTime;
      if (elapsed < this.throttleMs) {
        await new Promise((r) => setTimeout(r, this.throttleMs - elapsed));
      }

      this.sequence++;

      // 防止内容过大触发飞书格式错误：超出限制时截断并添加续传提示
      const contentBytes = Buffer.byteLength(fullText, 'utf8');
      const contentToSend =
        contentBytes > this.MAX_STREAMING_CONTENT_BYTES
          ? this.truncateForStreaming(fullText)
          : fullText;

      try {
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId!, element_id: 'content' },
          data: {
            content: contentToSend,
            sequence: this.sequence,
            uuid: `s_${this.cardId}_${this.sequence}`,
          },
        });
        this.lastUpdateTime = Date.now();
      } catch {
        // Non-fatal: stale update or rate limit
      }
    });

    await this.updateQueue;
  }

  /**
   * 截断超长内容，保留开头部分并添加续传提示。
   * 截断策略：
   * 1. 优先按段落边界截断（\n\n）
   * 2. 单个段落超长则按行截断
   * 3. 最后添加续传提示
   */
  private truncateForStreaming(text: string): string {
    const suffixBytes = Buffer.byteLength(this.CONTINUATION_SUFFIX, 'utf8');
    const availableBytes = this.MAX_STREAMING_CONTENT_BYTES - suffixBytes;

    // 尝试按段落截断
    const paragraphs = text.split(/\n{2,}/);
    let result = '';
    for (const para of paragraphs) {
      const separator = result ? '\n\n' : '';
      const additionBytes = Buffer.byteLength(separator + para, 'utf8');
      if (result && Buffer.byteLength(result, 'utf8') + additionBytes > availableBytes) {
        break;
      }
      result += separator + para;
    }

    // 如果单个段落就超长，按行截断
    if (!result) {
      const firstPara = paragraphs[0] || text;
      const lines = firstPara.split('\n');
      result = '';
      for (const line of lines) {
        const separator = result ? '\n' : '';
        if (Buffer.byteLength(result, 'utf8') + Buffer.byteLength(separator + line, 'utf8') > availableBytes) {
          break;
        }
        result += separator + line;
      }
    }

    return result + this.CONTINUATION_SUFFIX;
  }

  /** Close streaming mode and optionally update header. */
  async close(options?: {
    finalText?: string;
    header?: { template: string; title: string };
  }): Promise<void> {
    if (!this.cardId) return;

    const finalText = options?.finalText;
    const newHeader = options?.header;

    // Final content update if provided
    if (finalText && finalText !== this.lastContent) {
      await this.update(finalText);
    }

    // Close streaming + optionally update header
    this.sequence++;
    const summary = (this.lastContent || '').slice(0, 50);
    try {
      const settingsData: Record<string, unknown> = {
        streaming_mode: false,
        summary: { content: summary || 'Done' },
      };

      // Update header if provided
      if (newHeader) {
        settingsData.header = {
          title: { tag: 'plain_text', content: newHeader.title },
          template: newHeader.template,
        };
      }

      await this.client.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ config: settingsData }),
          sequence: this.sequence,
          uuid: `c_${this.cardId}_${this.sequence}`,
        },
      });
    } catch {
      // Non-fatal
    }
  }
}
