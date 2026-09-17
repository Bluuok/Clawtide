/**
 * Memory-only draft and navigation store.
 * Strictly in-memory (no localStorage / sessionStorage) to isolate by login session.
 * Wiped completely on logout so that late callbacks cannot repopulate stale data.
 */
import { create } from 'zustand';

export interface ProfileDraft {
  name: string;
  promptMode: 'append' | 'replace';
  segs: Record<string, string>;
  baseVersion: number;
}

export interface DraftFlowMemory {
  /** Null until stage 1 completes. */
  draftId: string | null;
  /** Null until stage 1 completes. */
  phrase: string | null;
  confirm: string;
  draftJson: string;
}

interface MemoryDraftState {
  authEpoch: number;
  selectedSessions: Record<string, string | null>;
  chatDrafts: Record<string, Record<string, string>>;
  profileDrafts: Record<string, Record<string, ProfileDraft>>;
  draftFlows: Record<string, Record<string, DraftFlowMemory>>;

  getSelectedSession: (userId?: string | null) => string | null;
  setSelectedSession: (userId: string | undefined | null, sessionId: string | null) => void;

  getChatDraft: (userId: string | undefined | null, sessionId: string) => string;
  setChatDraft: (userId: string | undefined | null, sessionId: string, draft: string) => void;

  getProfileDraft: (
    userId: string | undefined | null,
    profileId: string,
  ) => ProfileDraft | null;
  setProfileDraft: (
    userId: string | undefined | null,
    profileId: string,
    draft: ProfileDraft,
  ) => void;
  clearProfileDraft: (userId: string | undefined | null, profileId: string) => void;

  getDraftFlow: (
    userId: string | undefined | null,
    profileId: string,
  ) => DraftFlowMemory | null;
  setDraftFlow: (
    userId: string | undefined | null,
    profileId: string,
    state: DraftFlowMemory,
  ) => void;
  clearDraftFlow: (userId: string | undefined | null, profileId: string) => void;

  clearAll: () => void;
}

export const useMemoryDrafts = create<MemoryDraftState>()((set, get) => ({
  authEpoch: 0,
  selectedSessions: {},
  chatDrafts: {},
  profileDrafts: {},
  draftFlows: {},

  getSelectedSession: (userId) => {
    const uid = userId || 'anon';
    return get().selectedSessions[uid] ?? null;
  },

  setSelectedSession: (userId, sessionId) => {
    const uid = userId || 'anon';
    set((s) => ({
      selectedSessions: { ...s.selectedSessions, [uid]: sessionId },
    }));
  },

  getChatDraft: (userId, sessionId) => {
    const uid = userId || 'anon';
    return get().chatDrafts[uid]?.[sessionId] ?? '';
  },

  setChatDraft: (userId, sessionId, draft) => {
    const uid = userId || 'anon';
    set((s) => ({
      chatDrafts: {
        ...s.chatDrafts,
        [uid]: {
          ...(s.chatDrafts[uid] ?? {}),
          [sessionId]: draft,
        },
      },
    }));
  },

  getProfileDraft: (userId, profileId) => {
    const uid = userId || 'anon';
    return get().profileDrafts[uid]?.[profileId] ?? null;
  },

  setProfileDraft: (userId, profileId, draft) => {
    const uid = userId || 'anon';
    set((s) => ({
      profileDrafts: {
        ...s.profileDrafts,
        [uid]: {
          ...(s.profileDrafts[uid] ?? {}),
          [profileId]: draft,
        },
      },
    }));
  },

  clearProfileDraft: (userId, profileId) => {
    const uid = userId || 'anon';
    set((s) => {
      const userDrafts = { ...(s.profileDrafts[uid] ?? {}) };
      delete userDrafts[profileId];
      return {
        profileDrafts: { ...s.profileDrafts, [uid]: userDrafts },
      };
    });
  },

  getDraftFlow: (userId, profileId) => {
    const uid = userId || 'anon';
    return get().draftFlows[uid]?.[profileId] ?? null;
  },

  setDraftFlow: (userId, profileId, flow) => {
    const uid = userId || 'anon';
    set((s) => ({
      draftFlows: {
        ...s.draftFlows,
        [uid]: {
          ...(s.draftFlows[uid] ?? {}),
          [profileId]: flow,
        },
      },
    }));
  },

  clearDraftFlow: (userId, profileId) => {
    const uid = userId || 'anon';
    set((s) => {
      const userFlows = { ...(s.draftFlows[uid] ?? {}) };
      delete userFlows[profileId];
      return {
        draftFlows: { ...s.draftFlows, [uid]: userFlows },
      };
    });
  },

  clearAll: () => {
    set((s) => ({
      authEpoch: s.authEpoch + 1,
      selectedSessions: {},
      chatDrafts: {},
      profileDrafts: {},
      draftFlows: {},
    }));
  },
}));
