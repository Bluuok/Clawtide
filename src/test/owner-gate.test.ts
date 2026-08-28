/**
 * R20 IM Owner Gate (spec §6.4 必备测试): owner passes, non-owner silently
 * dropped, no-receipt semantics by construction (verdict, not side effect),
 * destructive command list, audience modes.
 */
import { describe, expect, it } from 'vitest';
import { checkOwnerGate, OWNER_REQUIRED_IM_COMMANDS, type GateInput } from '../owner-gate.js';

function gate(overrides: Partial<GateInput> = {}): GateInput {
  return {
    senderId: 'im-999',
    ownerImId: 'im-42',
    audienceMode: 'everyone',
    ...overrides,
  };
}

describe('Owner Gate', () => {
  it('owner id match executes regardless of audience mode', () => {
    expect(checkOwnerGate(gate({ senderId: 'im-42' })).action).toBe('execute');
    expect(checkOwnerGate(gate({ senderId: 'im-42', audienceMode: 'owner_only' })).action).toBe(
      'execute',
    );
  });

  it('non-owner in owner_only mode: silent drop', () => {
    const v = checkOwnerGate(gate({ audienceMode: 'owner_only' }));
    expect(v.action).toBe('silent_drop');
  });

  it('non-owner in everyone mode: executes (visible audience mode)', () => {
    expect(checkOwnerGate(gate()).action).toBe('execute');
  });

  it('disabled mode drops even the owner', () => {
    const v = checkOwnerGate(gate({ senderId: 'im-42', audienceMode: 'disabled' }));
    expect(v).toEqual({ action: 'silent_drop', reason: 'audience_mode=disabled' });
  });

  it('destructive commands are owner-only even in everyone mode', () => {
    for (const cmd of OWNER_REQUIRED_IM_COMMANDS) {
      const v = checkOwnerGate(gate({ command: cmd }));
      expect(v.action).toBe('silent_drop');
    }
    expect(checkOwnerGate(gate({ command: '/bind', senderId: 'im-42' })).action).toBe(
      'execute',
    );
  });

  it('unbound owner_im_id never authenticates anyone', () => {
    for (const owner of [null, undefined]) {
      const v = checkOwnerGate(gate({ ownerImId: owner, audienceMode: 'owner_only' }));
      expect(v.action).toBe('silent_drop');
      // everyone mode still lets traffic through — that's the point of the mode.
      expect(checkOwnerGate(gate({ ownerImId: owner })).action).toBe('execute');
    }
  });

  it('silent drop verdicts carry a reason (log-only, never sent to the channel)', () => {
    const v = checkOwnerGate(gate({ command: '/unbind', audienceMode: 'everyone' }));
    expect(v.action === 'silent_drop' && v.reason.length > 0).toBe(true);
  });
});
