/**
 * Session store: who is logged in, and whether setup (first user) has
 * happened. Bootstrapped once at app mount via GET /auth/me; 401 simply
 * means "not logged in", not an error toast.
 */
import { create } from 'zustand';
import { api, ApiError, type PublicUser } from '../api.js';

interface SessionState {
  /** undefined = bootstrap not finished; null = not logged in; set = logged in. */
  user: PublicUser | null | undefined;
  checked: boolean;
  bootstrapError: string | null;
  bootstrap: () => Promise<void>;
  setUser: (user: PublicUser | null) => void;
}

export const useSession = create<SessionState>((set) => ({
  user: undefined,
  checked: false,
  bootstrapError: null,
  bootstrap: async () => {
    set({ checked: false, bootstrapError: null });
    try {
      const { user } = await api.get<{ user: PublicUser }>('/auth/me');
      set({ user, checked: true, bootstrapError: null });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        set({ user: null, checked: true, bootstrapError: null });
        return;
      }
      set({
        user: undefined,
        checked: true,
        bootstrapError: 'Could not connect to Clawtide. Check the server and try again.',
      });
    }
  },
  setUser: (user) => set({ user, checked: true, bootstrapError: null }),
}));
