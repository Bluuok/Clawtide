/**
 * R20 tri-state RBAC (spec §6.4 必备测试): the full roles × resource-shapes ×
 * operations matrix, legacy re-derivation both branches, admin no-bypass,
 * home undeletable.
 */
import { describe, expect, it } from 'vitest';
import {
  canAccessGroup,
  canModifyGroup,
  canDeleteGroup,
  type RbacUser,
  type WorkspaceResource,
  type SiblingHomeResolver,
} from '../rbac.js';

const admin: RbacUser = { id: 'u-admin', role: 'admin' };
const alice: RbacUser = { id: 'u-alice', role: 'member' };
const bob: RbacUser = { id: 'u-bob', role: 'member' };

const HOME_ALICE: WorkspaceResource = {
  jid: 'web:home-alice',
  is_home: 1,
  folder: 'home-alice',
  created_by: 'u-alice',
};
const IM_GROUP_OWNED_BY_ALICE: WorkspaceResource = {
  jid: 'tg:-100123',
  is_home: 0,
  folder: 'shop-a',
  created_by: 'u-alice',
};
const WEB_GROUP_OWNED_BY_ALICE: WorkspaceResource = {
  jid: 'web:shop-a',
  is_home: 0,
  folder: 'shop-a',
  created_by: 'u-alice',
};
const LEGACY_RESOLVABLE: WorkspaceResource = {
  jid: 'wa:8613800138000',
  is_home: 0,
  folder: 'shop-a',
  created_by: null,
};
const LEGACY_ORPHAN: WorkspaceResource = {
  jid: 'wa:8613800138001',
  is_home: 0,
  folder: 'nobody-owns-this',
  created_by: null,
};

const resolveAliceHome: SiblingHomeResolver = (folder) =>
  folder === 'shop-a' || folder === 'home-alice' ? 'u-alice' : null;

const neverResolve: SiblingHomeResolver = () => null;

describe('R20 tri-state matrix', () => {
  interface Row {
    name: string;
    user: RbacUser;
    ws: WorkspaceResource;
    resolver?: SiblingHomeResolver;
    access: boolean;
    modify: boolean;
    delete: boolean;
  }

  const rows: Row[] = [
    {
      name: 'home owner: access+modify, never delete',
      user: alice,
      ws: HOME_ALICE,
      access: true,
      modify: true,
      delete: false,
    },
    {
      name: 'home foreign member: all denied',
      user: bob,
      ws: HOME_ALICE,
      access: false,
      modify: false,
      delete: false,
    },
    // The load-bearing assertion: admin has NO ownership bypass.
    {
      name: 'admin on foreign home: all denied (no bypass)',
      user: admin,
      ws: HOME_ALICE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'IM group owner: all allowed',
      user: alice,
      ws: IM_GROUP_OWNED_BY_ALICE,
      access: true,
      modify: true,
      delete: true,
    },
    {
      name: 'IM group foreign member: all denied',
      user: bob,
      ws: IM_GROUP_OWNED_BY_ALICE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'IM group admin (not owner): all denied (no bypass)',
      user: admin,
      ws: IM_GROUP_OWNED_BY_ALICE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'web group owner: all allowed',
      user: alice,
      ws: WEB_GROUP_OWNED_BY_ALICE,
      access: true,
      modify: true,
      delete: true,
    },
    {
      name: 'web group foreign: all denied',
      user: bob,
      ws: WEB_GROUP_OWNED_BY_ALICE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'web group admin (not owner): all denied (no bypass)',
      user: admin,
      ws: WEB_GROUP_OWNED_BY_ALICE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'legacy resolvable owner: all allowed',
      user: alice,
      ws: LEGACY_RESOLVABLE,
      access: true,
      modify: true,
      delete: true,
    },
    {
      name: 'legacy resolvable foreign member: all denied',
      user: bob,
      ws: LEGACY_RESOLVABLE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'legacy resolvable admin: all denied (no bypass)',
      user: admin,
      ws: LEGACY_RESOLVABLE,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'legacy orphan owner (cannot re-derive): deny by default',
      user: alice,
      ws: LEGACY_ORPHAN,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'legacy orphan admin: deny by default',
      user: admin,
      ws: LEGACY_ORPHAN,
      access: false,
      modify: false,
      delete: false,
    },
    {
      name: 'legacy orphan, resolver broken: deny (fail closed)',
      user: alice,
      ws: LEGACY_RESOLVABLE,
      resolver: neverResolve,
      access: false,
      modify: false,
      delete: false,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const resolver = r.resolver ?? resolveAliceHome;
      expect(canAccessGroup(r.user, r.ws, resolver)).toBe(r.access ? 'allow' : 'deny');
      expect(canModifyGroup(r.user, r.ws, resolver)).toBe(r.modify ? 'allow' : 'deny');
      expect(canDeleteGroup(r.user, r.ws, resolver)).toBe(r.delete ? 'allow' : 'deny');
    });
  }
});

describe('R20 invariants', () => {
  it('canDeleteGroup denies home for every role combination', () => {
    for (const user of [alice, bob, admin]) {
      expect(canDeleteGroup(user, HOME_ALICE, resolveAliceHome)).toBe('deny');
    }
  });

  it('verdicts come only from ownership, never from the role value', () => {
    // Swapping the role on the same user id must not change any verdict.
    const aliceAsAdmin: RbacUser = { id: 'u-alice', role: 'admin' };
    const aliceAsMember: RbacUser = { id: 'u-alice', role: 'member' };
    for (const ws of [
      HOME_ALICE,
      IM_GROUP_OWNED_BY_ALICE,
      WEB_GROUP_OWNED_BY_ALICE,
      LEGACY_RESOLVABLE,
    ]) {
      expect(canAccessGroup(aliceAsAdmin, ws, resolveAliceHome)).toBe(
        canAccessGroup(aliceAsMember, ws, resolveAliceHome),
      );
      expect(canModifyGroup(aliceAsAdmin, ws, resolveAliceHome)).toBe(
        canModifyGroup(aliceAsMember, ws, resolveAliceHome),
      );
      expect(canDeleteGroup(aliceAsAdmin, ws, resolveAliceHome)).toBe(
        canDeleteGroup(aliceAsMember, ws, resolveAliceHome),
      );
    }
  });
});
