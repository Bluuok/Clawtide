/**
 * Session store: who is logged in, and whether setup (first user) has
 * happened. Bootstrapped once at app mount via GET /auth/me; 401 simply
 * means "not logged in", not an error toast.
 */
import { create } from 'zustand';
import { api, type PublicUser } from '../api.js';

interface SessionState {
  /** undefined = bootstrap not finished; null = not logged in; set = logged in. */
  user: PublicUser | null | undefined;
  checked: boolean;
  bootstrap: () => Promise<void>;
  setUser: (user: PublicUser | null) => void;
}

export const useSession = create<SessionState>((set) => ({
  user: undefined,
  checked: false,
  bootstrap: async () => {
    try {
      const { user } = await api.get<{ user: PublicUser }>('/auth/me');
      set({ user, checked: true });
    } catch {
      set({ user: null, checked: true });
    }
  },
  setUser: (user) => set({ user, checked: true }),
}));
