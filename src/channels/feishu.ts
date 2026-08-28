/**
 * Feishu (Lark) adapter — real connection via the official Node SDK in
 * WebSocket mode (spec §6.5 item 3). The SDK client is created lazily on
 * start(); missing app credentials fail loudly (NOT VERIFIED unless an
 * operator provides a real app).
 */
import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import {
  CAPABILITY_PRESETS,
  type ChannelCapabilities,
  type ImChannelAdapter,
  type InboundMessage,
  type OutboundContent,
  type OutboundTarget,
  type SendReceipt,
} from '../im-channel.js';

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  accountId: string;
}

export class FeishuAdapter implements ImChannelAdapter {
  readonly channel = 'feishu' as const;
  private client: Client | null = null;
  private wsClient: WSClient | null = null;

  constructor(private readonly opts: FeishuAdapterOptions) {}

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITY_PRESETS.feishu };
  }

  async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const client = new Client({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
    });
    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: FeishuReceiveEvent) => {
        const msg = data.message;
        if (msg === undefined) return;
        const chatType = msg.chat_type === 'p2p' ? 'direct' : 'group';
        const inbound: InboundMessage = {
          channel: 'feishu',
          accountId: this.opts.accountId,
          conversation: {
            kind: chatType,
            jid: `feishu:${msg.chat_id}`,
            ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
          },
          senderId: msg.sender?.sender_id?.open_id ?? '',
          ...(typeof msg.content === 'string' ? { text: extractFeishuText(msg.content) } : {}),
          attachments: [],
          messageId: msg.message_id ?? '',
          ts: msg.create_time ?? new Date().toISOString(),
        };
        await onInbound(inbound);
      },
    });
    const wsClient = new WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
    });
    await wsClient.start({ eventDispatcher });
    this.client = client;
    this.wsClient = wsClient;
  }

  async stop(): Promise<void> {
    // The WS SDK exposes no graceful stop; dropping the reference closes the
    // socket on GC. Nothing pending is lost: delivery is request/response.
    this.wsClient = null;
    this.client = null;
  }

  async send(target: OutboundTarget, content: OutboundContent): Promise<SendReceipt> {
    if (this.client === null) throw new Error('feishu adapter not started');
    if (content.kind !== 'text') {
      throw new Error('feishu media send not in scope for this occurrence');
    }
    const chatId = target.conversation.jid.replace(/^feishu:/, '');
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content.text }),
      },
    });
    if (res.code !== 0) throw new Error(`feishu send failed: ${res.code} ${res.msg}`);
    return {
      messageId: res.data?.message_id ?? '',
      ts: new Date().toISOString(),
    };
  }
}

/** Native im.message.receive_v1 payload shape (only the fields we consume). */
interface FeishuReceiveEvent {
  message?: {
    chat_id?: string;
    chat_type?: string;
    thread_id?: string;
    message_id?: string;
    content?: string;
    create_time?: string;
    sender?: { sender_id?: { open_id?: string } };
  };
}

/** Feishu wraps payloads as {"text":"..."} JSON in im.message.receive_v1. */
function extractFeishuText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as { text?: string };
    return parsed.text ?? '';
  } catch {
    return '';
  }
}
