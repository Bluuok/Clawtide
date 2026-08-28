/**
 * Skeleton adapter base (spec §6.5 item 4): adapter shell + capability
 * declaration only. Transport is injected so contract tests can drive real
 * channel payload fixtures through the mapping without any SDK or network.
 * Skeletons never pretend to be connected: start() with a null transport is
 * an explicit error.
 */
import {
  CAPABILITY_PRESETS,
  type ChannelCapabilities,
  type ChannelId,
  type ImChannelAdapter,
  type InboundMessage,
  type OutboundContent,
  type OutboundTarget,
  type SendReceipt,
} from '../im-channel.js';

/**
 * Transport seam. A real adapter wraps its SDK here; the skeleton contract
 * tests inject a fake that replays captured payload fixtures.
 */
export interface ChannelTransport {
  /** Map one native inbound payload into the unified model. */
  parseInbound(raw: unknown): InboundMessage;
  /** Render one unified outbound into the channel's API call shape. */
  renderOutbound(target: OutboundTarget, content: OutboundContent): unknown;
  /** Deliver a rendered outbound via the channel API (mocked in tests). */
  deliver(rendered: unknown): Promise<SendReceipt>;
}

export class SkeletonAdapter implements ImChannelAdapter {
  private onInbound: ((msg: InboundMessage) => Promise<void>) | null = null;

  constructor(
    readonly channel: ChannelId,
    private readonly transport: ChannelTransport | null,
    capabilitiesOverride?: Partial<ChannelCapabilities>,
  ) {
    void capabilitiesOverride; // presets are authoritative for skeletons
  }

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITY_PRESETS[this.channel] };
  }

  async start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {
    if (this.transport === null) {
      throw new Error(
        `channel ${this.channel} is a skeleton: transport not configured (spec marks this NOT VERIFIED)`,
      );
    }
    this.onInbound = onInbound;
  }

  async stop(): Promise<void> {
    this.onInbound = null;
  }

  async send(target: OutboundTarget, content: OutboundContent): Promise<SendReceipt> {
    if (this.transport === null) throw new Error(`channel ${this.channel} transport missing`);
    const rendered = this.transport.renderOutbound(target, content);
    return this.transport.deliver(rendered);
  }

  /** Test/transport hook: push a parsed native payload into the pipeline. */
  async dispatchInbound(raw: unknown): Promise<void> {
    if (this.transport === null) throw new Error(`channel ${this.channel} transport missing`);
    if (this.onInbound === null) throw new Error('adapter not started');
    await this.onInbound(this.transport.parseInbound(raw));
  }
}
