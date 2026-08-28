/**
 * R20 — IM Owner Gate. The heaviest wall in the admission chain: an inbound
 * IM message executes only when the channel-native sender id matches the
 * `owner_im_id` bound to the channel account for that workspace. A mismatched
 * sender is refused WITHOUT any reply — no receipt, no error message — so the
 * gate cannot be probed (an attacker learns nothing, not even that a
 * workspace exists).
 *
 * Cross-channel identity is deliberately NOT unified: the same human on two
 * channels is two identities, each bound separately (owner_im_id lives on the
 * channel account, not the user).
 */

/** Destructive/binding IM commands that always require the owner. */
export const OWNER_REQUIRED_IM_COMMANDS = new Set(['/bind', '/unbind']);

export type AudienceMode = 'everyone' | 'owner_only' | 'disabled';

export interface GateInput {
  /** Channel-native sender id from the adapter's InboundMessage. */
  senderId: string;
  /** owner_im_id bound at workspace/account creation time. */
  ownerImId: string | null | undefined;
  audienceMode: AudienceMode;
  /** Parsed command word when the text starts with '/', else undefined. */
  command?: string;
}

export type GateVerdict =
  | { action: 'execute' }
  /** Silent drop: no execution, no reply, no error surface. */
  | { action: 'silent_drop'; reason: string };

export function checkOwnerGate(input: GateInput): GateVerdict {
  if (input.audienceMode === 'disabled') {
    return { action: 'silent_drop', reason: 'audience_mode=disabled' };
  }
  const isOwner =
    input.ownerImId !== null &&
    input.ownerImId !== undefined &&
    input.ownerImId === input.senderId;
  const destructive =
    input.command !== undefined && OWNER_REQUIRED_IM_COMMANDS.has(input.command);
  if (isOwner) {
    return { action: 'execute' };
  }
  // Non-owner: destructive commands are always dropped; regular traffic
  // depends on the audience mode.
  if (destructive) {
    return { action: 'silent_drop', reason: 'owner-required command from non-owner' };
  }if (input.audienceMode === 'owner_only') {
    return { action: 'silent_drop', reason: 'audience_mode=owner_only' };
  }
  return { action: 'execute' };
}
