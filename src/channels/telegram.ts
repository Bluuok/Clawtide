/**
 * Telegram adapter — real connection via grammY long polling (spec §6.5 item
 * 3: no public webhook needed, proxy friendly). Long-message splitting is
 * done HERE because Telegram has no native split (4096-char hard limit).
 */
import { Bot } from 'grammy';
import {
  CAPABILITY_PRESETS,
  splitLongText,
  type ChannelCapabilities,
  type ImChannelAdapter,
  type InboundMessage,
  type OutboundContent,
  type OutboundTarget,
  type SendReceipt,
} from '../im-channel.js';

export interface TelegramAdapterOptions {
  botToken: string;
  accountId: string;
}

export class TelegramAdapter implements ImChannelAdapter {
  readonly channel = 'telegram' as const;
  private bot: Bot | null = null;
  private running = false;

  constructor(private readonly opts: TelegramAdapterOptions) {}

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITY_PRESETS.telegram };
  }

  async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const bot = new Bot(this.opts.botToken);
    bot.on('message', async (ctx) => {
      const msg = ctx.message;
      if (msg === undefined) return;
      const chat = msg.chat;
      const inbound: InboundMessage = {
        channel: 'telegram',
        accountId: this.opts.accountId,
        conversation: {
          kind: chat.type === 'private' ? 'direct' : 'group',
          jid: `telegram:${chat.id}`,
          ...(chat.is_forum && msg.message_thread_id
            ? { threadId: String(msg.message_thread_id) }
            : {}),
        },
        senderId: String(msg.from?.id ?? ''),
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        attachments: [],
        messageId: String(msg.message_id),
        ts: new Date(msg.date * 1000).toISOString(),
      };
      await onInbound(inbound);
    });
    // Long polling — grammY handles offset tracking and backoff internally.
    void bot.start({ drop_pending_updates: false });
    this.bot = bot;
    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.bot !== null && this.running) {
      await this.bot.stop();
    }
    this.running = false;
    this.bot = null;
  }

  async send(target: OutboundTarget, content: OutboundContent): Promise<SendReceipt> {
    if (this.bot === null) throw new Error('telegram adapter not started');
    if (content.kind !== 'text') {
      throw new Error('telegram media send not in scope for this occurrence');
    }
    const chatId = target.conversation.jid.replace(/^telegram:/, '');
    const chunks = splitLongText(content.text, 4096);
    let lastId = '';
    for (const chunk of chunks) {
      const sent = await this.bot.api.sendMessage(chatId, chunk, {
        ...(target.conversation.threadId !== undefined
          ? { message_thread_id: Number(target.conversation.threadId) }
          : {}),
        ...(target.replyToMessageId !== undefined
          ? { reply_parameters: { message_id: Number(target.replyToMessageId) } }
          : {}),
      });
      lastId = String(sent.message_id);
    }
    return { messageId: lastId, ts: new Date().toISOString() };
  }
}
