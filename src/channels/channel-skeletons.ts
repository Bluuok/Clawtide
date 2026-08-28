/**
 * Skeleton channel adapters (spec §6.5 item 4): adapter shell + capability
 * declaration, exercised via contract tests over a mocked transport. No SDK
 * is installed for skeleton channels (spec §3). Each file records the native
 * payload shape its transport would need to parse.
 */
import { SkeletonAdapter, type ChannelTransport } from './skeleton.js';

export type { ChannelTransport };

export class QQAdapter extends SkeletonAdapter {
  constructor(transport: ChannelTransport | null = null) {
    super('qq', transport);
  }
}

export class DingTalkAdapter extends SkeletonAdapter {
  constructor(transport: ChannelTransport | null = null) {
    super('dingtalk', transport);
  }
}

export class WeChatAdapter extends SkeletonAdapter {
  constructor(transport: ChannelTransport | null = null) {
    super('wechat', transport);
  }
}

export class DiscordAdapter extends SkeletonAdapter {
  constructor(transport: ChannelTransport | null = null) {
    super('discord', transport);
  }
}

export class WhatsAppAdapter extends SkeletonAdapter {
  constructor(transport: ChannelTransport | null = null) {
    super('whatsapp', transport);
  }
}
