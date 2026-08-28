/**
 * R07 — the seven-channel unified abstraction (spec §6.5).
 *
 * The Agent core speaks ONLY InboundMessage/OutboundContent; channel
 * differences stop at the adapter boundary. Each adapter declares its
 * capabilities declaratively — upper layers degrade by reading them, never
 * by sniffing channel ids. Skeleton adapters (qq/dingtalk/wechat/discord/
 * whatsapp) implement the shell + capability declaration and are exercised
 * through contract tests against a mocked transport; they do NOT install any
 * SDK (spec §3: 骨架渠道不装 SDK).
 */

export type ChannelId =
  'feishu' | 'telegram' | 'qq' | 'dingtalk' | 'wechat' | 'discord' | 'whatsapp';

/** Declarative capability matrix — the degradation driver (spec §6.5 item 2). */
export interface ChannelCapabilities {
  /** Can receive messages from group conversations. */
  supportsGroup: boolean;
  /** Can receive direct (1:1) messages. */
  supportsDirect: boolean;
  /** Native topic/forum threads map to separate runtime sessions. */
  supportsThreads: boolean;
  /** Can send images/files. */
  supportsMedia: boolean;
  /** Platform splits long messages itself (false → adapter must chunk). */
  supportsLongMessageSplit: boolean;
  /** Progressive streaming updates (cards / edit-in-place). */
  supportsStreaming: boolean;
  /** Adapter's hard per-message character limit (null = none known). */
  maxMessageChars: number | null;
}

export interface ConversationRef {
  kind: 'group' | 'direct';
  jid: string;
  threadId?: string;
}

export interface InboundAttachment {
  name: string;
  mimeType: string | null;
  /** Transport-specific fetchable reference; adapters resolve to bytes lazily. */
  url: string | null;
}

/** The unified inbound message model — the ONLY shape the core sees. */
export interface InboundMessage {
  channel: ChannelId;
  accountId: string;
  conversation: ConversationRef;
  senderId: string;
  text?: string;
  attachments: InboundAttachment[];
  messageId: string;
  ts: string;
}

export interface OutboundTarget {
  conversation: ConversationRef;
  /** Reply-to message id when the channel supports quoting. */
  replyToMessageId?: string;
}

export interface OutboundTextContent {
  kind: 'text';
  text: string;
}

export interface OutboundMediaContent {
  kind: 'media';
  name: string;
  mimeType: string | null;
  data: Uint8Array;
}

export type OutboundContent = OutboundTextContent | OutboundMediaContent;

export interface SendReceipt {
  messageId: string;
  ts: string;
}

export interface ImChannelAdapter {
  readonly channel: ChannelId;
  capabilities(): ChannelCapabilities;
  /** Bind the transport and route every inbound message to `onInbound`. */
  start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, content: OutboundContent): Promise<SendReceipt>;
}

/** Capability presets shared by adapters; per-adapter overrides stay explicit. */
export const CAPABILITY_PRESETS: Record<ChannelId, ChannelCapabilities> = {
  feishu: {
    supportsGroup: true,
    supportsDirect: true,
    supportsThreads: true, // topics (话题群)
    supportsMedia: true,
    supportsLongMessageSplit: true, // interactive cards handle long content
    supportsStreaming: true, // streaming cards
    maxMessageChars: null,
  },
  telegram: {
    supportsGroup: true,
    supportsDirect: true,
    supportsThreads: true, // forum topics
    supportsMedia: true,
    // 4096-char hard limit: THE long-message-split sample (spec §6.5 item 2).
    supportsLongMessageSplit: false,
    supportsStreaming: false,
    maxMessageChars: 4096,
  },
  qq: {
    supportsGroup: true,
    supportsDirect: true,
    supportsThreads: false,
    supportsMedia: true,
    supportsLongMessageSplit: false,
    supportsStreaming: false,
    maxMessageChars: 4500,
  },
  dingtalk: {
    supportsGroup: true,
    supportsDirect: true,
    supportsThreads: false,
    supportsMedia: true,
    supportsLongMessageSplit: true, // markdown/actionCard messages
    supportsStreaming: false,
    maxMessageChars: null,
  },
  // WeChat (iLink) is P2P only — group support is factually absent, and the
  // capability matrix is where that scope statement becomes visible code.
  wechat: {
    supportsGroup: false,
    supportsDirect: true,
    supportsThreads: false,
    supportsMedia: true,
    supportsLongMessageSplit: false,
    supportsStreaming: false,
    maxMessageChars: 2048,
  },
  discord: {
    supportsGroup: true,
    supportsDirect: true,
    supportsThreads: true,
    supportsMedia: true,
    supportsLongMessageSplit: true, // embeds
    supportsStreaming: false,
    maxMessageChars: 2000,
  },
  whatsapp: {
    supportsGroup: true,
    supportsDirect: true,
    supportsThreads: false,
    supportsMedia: true,
    supportsLongMessageSplit: false,
    supportsStreaming: false,
    maxMessageChars: 65536,
  },
};

/** Long-message chunking for channels without native split support. */
export function splitLongText(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer breaking at the last newline inside the window; fall back to a
    // hard cut. No silent truncation — every character is delivered.
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  chunks.push(rest);
  return chunks;
}
