/**
 * Chat streaming store — consumes the `/ws` StreamEvent envelope.
 *
 * Reconnect policy (spec §5-10 防线三件套): exponential backoff with jitter,
 * reset on a successful (re)connect; while offline the socket state is shown,
 * never silently swallowed. Per-session message buffers keep the transcript
 * so a virtualized list can render long histories without holding DOM nodes.
 */
import { create } from 'zustand';
import type { StreamEvent } from '@shared/stream.js';
import type { WsEnvelope } from '@shared/protocol.js';
import { api, ApiError, type ChatMessage } from '../api.js';

export interface ChatEntry {
  /** Client-side identity; server messages are keyed by role+ts on load. */
  key: string;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  /** Streaming: more fragments may still arrive for this entry. */
  streaming: boolean;
  interrupted?: boolean;
  kind: 'text' | 'tool' | 'error';
  status?: 'sent' | 'unconfirmed' | 'failed';
  toolName?: string;
  toolStatus?: 'started' | 'done' | 'failed';
  isError?: boolean;
}

interface ChatState {
  socketStatus: 'connecting' | 'open' | 'closed';
  /** Attempts since last successful open — drives the backoff delay. */
  reconnectAttempt: number;
  /** sessionId → transcript entries for the virtualized list. */
  entries: Record<string, ChatEntry[]>;
  /** sessionId → whether a turn is currently in progress. */
  sessionBusy: Record<string, boolean>;
  /** sessionId → error if post-turn snapshot sync or manual sync failed. */
  syncError: Record<string, string | null>;

  connect: () => void;
  disconnect: () => void;
  clearUserScope: () => void;
  sendChat: (sessionId: string, content: string) => Promise<void>;
  loadTranscript: (sessionId: string) => Promise<void>;
  clearLocal: (sessionId: string) => void;
}

/** Socket + backoff plumbing lives outside the store: private mutable singletons. */
let ws: WebSocket | undefined;
let backoffTimer: ReturnType<typeof setTimeout> | undefined;
let explicitlyClosed = false;
let currentConnectionId = 0;
let currentAuthEpoch = 0;

/** Generation and revision trackers for race-free conservative snapshot reconciliation. */
const sessionRequestGen: Record<string, number> = {};
const localRevision: Record<string, number> = {};
/** Only a start observed on this connection establishes a complete live body. */
const observedTurnStart = new Set<string>();

/** Base delay for the exponential backoff (doubles per attempt, capped). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

function backoffDelay(attempt: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  // Full jitter: any value in [0, exp) — avoids reconnect thundering herds.
  return Math.random() * exp;
}

let entryKey = 0;
const nextKey = () => `e${++entryKey}`;

/** Maximum user input content length matching backend schema contract. */
export const MAX_CHAT_CONTENT_LENGTH = 100_000;

/**
 * Conservative snapshot reconciliation:
 * Merges server-persisted transcript with local entries:
 * - Uses ordered exact role and content identity (never arbitrary time proximity).
 * - Preserves server history before new local entries.
 * - Avoids duplicates on repeated snapshots.
 * - Strictly never erases:
 *   1. Active streaming entries.
 *   2. Tool activity entries (persisted server-side in tool_events, not in chat_messages).
 *   3. Error entries (partial/aborted turn errors not persisted in chat_messages).
 *   4. Locally unconfirmed or failed sends.
 *   5. Completed assistant turns not yet written to disk by backend's post-turn persist step.
 */
export function reconcileTranscript(local: ChatEntry[], server: ChatEntry[]): ChatEntry[] {
  if (server.length === 0) return local;

  const result: ChatEntry[] = [];
  const matchedServerIndices = new Set<number>();
  let lastMatchedServerIdx = -1;

  for (const lEntry of local) {
    // Keep unpersisted / special local entries exactly in order
    if (
      lEntry.streaming ||
      lEntry.interrupted ||
      lEntry.kind === 'tool' ||
      lEntry.kind === 'error' ||
      lEntry.status === 'failed' ||
      lEntry.status === 'unconfirmed'
    ) {
      result.push(lEntry);
      continue;
    }

    // Match persisted text entries by exact role and content identity
    let matchedIdx = -1;
    for (let i = lastMatchedServerIdx + 1; i < server.length; i++) {
      const s = server[i];
      if (
        !matchedServerIndices.has(i) &&
        s.role === lEntry.role &&
        s.content === lEntry.content
      ) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      // Catch up any prior server entries that appeared before this match
      for (let i = lastMatchedServerIdx + 1; i < matchedIdx; i++) {
        if (!matchedServerIndices.has(i)) {
          result.push(server[i]);
          matchedServerIndices.add(i);
        }
      }
      // Use the canonical server timestamp and status for loaded rows
      result.push({
        ...lEntry,
        ts: server[matchedIdx].ts,
        status: 'sent',
        streaming: false,
      });
      matchedServerIndices.add(matchedIdx);
      lastMatchedServerIdx = matchedIdx;
    } else {
      // Local text entry not yet present in server snapshot (e.g. pre-persist assistant turn)
      result.push(lEntry);
    }
  }

  // Append any remaining server entries
  for (let i = 0; i < server.length; i++) {
    if (!matchedServerIndices.has(i)) {
      result.push(server[i]);
    }
  }

  return result;
}

export const useChat = create<ChatState>()((set, get) => ({
  socketStatus: 'closed',
  reconnectAttempt: 0,
  entries: {},
  sessionBusy: {},
  syncError: {},

  connect: () => {
    if (ws !== undefined && ws.readyState <= WebSocket.OPEN) return;
    explicitlyClosed = false;
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }

    const connId = ++currentConnectionId;
    set({ socketStatus: 'connecting' });

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws = socket;

    socket.onopen = () => {
      if (connId !== currentConnectionId) return;
      // Reset the backoff ladder on successful open
      set({ socketStatus: 'open', reconnectAttempt: 0 });
    };

    socket.onmessage = (ev) => {
      if (connId !== currentConnectionId) return;
      let envelope: WsEnvelope<unknown>;
      try {
        envelope = JSON.parse(String(ev.data)) as WsEnvelope<unknown>;
      } catch {
        return; // Malformed frame: ignore, never crash
      }
      if (envelope.type === 'stream') {
        handleStreamEvent(envelope.payload as StreamEvent, set, get);
      }
    };

    socket.onclose = () => {
      if (connId !== currentConnectionId) return;
      ws = undefined;
      observedTurnStart.clear();

      // When the socket drops unexpectedly while busy, settle streaming to interrupted state
      // so session is not permanently stuck as busy, and mark unconfirmed
      set((s) => {
        const nextEntries: Record<string, ChatEntry[]> = {};
        const syncError = { ...s.syncError };
        for (const sid of Object.keys(s.sessionBusy)) {
          if (s.sessionBusy[sid]) {
            localRevision[sid] = (localRevision[sid] ?? 0) + 1;
            syncError[sid] =
              'Realtime connection interrupted. Turn status is unconfirmed; sync the transcript before sending again.';
          }
        }
        let modified = false;
        for (const [sid, list] of Object.entries(s.entries)) {
          const hadStreaming = list.some((e) => e.streaming);
          if (hadStreaming || s.sessionBusy[sid]) {
            modified = true;
            nextEntries[sid] = list.map((e) => {
              if (e.streaming) {
                return { ...e, streaming: false, interrupted: true };
              }
              return e;
            });
          } else {
            nextEntries[sid] = list;
          }
        }
        return {
          socketStatus: 'closed',
          sessionBusy: {},
          syncError,
          ...(modified ? { entries: nextEntries } : {}),
        };
      });

      if (explicitlyClosed) return;

      // Exponential backoff reconnect with jitter
      const attempt = get().reconnectAttempt;
      const delay = backoffDelay(attempt);
      set({ reconnectAttempt: attempt + 1 });
      backoffTimer = setTimeout(() => {
        if (connId === currentConnectionId && !explicitlyClosed) {
          get().connect();
        }
      }, delay);
    };

    socket.onerror = () => {
      if (connId !== currentConnectionId) return;
      // onclose always follows onerror; backoff logic lives there
    };
  },

  disconnect: () => {
    observedTurnStart.clear();
    explicitlyClosed = true;
    currentConnectionId++;
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }
    if (ws !== undefined) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = undefined;
    }
    // Disconnect closes all streaming tails and settles busy flags without wiping cached transcript
    set((s) => {
      const settledEntries: Record<string, ChatEntry[]> = {};
      let changed = false;
      for (const [sid, list] of Object.entries(s.entries)) {
        if (list.some((e) => e.streaming)) {
          changed = true;
          settledEntries[sid] = list.map((e) =>
            e.streaming ? { ...e, streaming: false, interrupted: true } : e,
          );
        } else {
          settledEntries[sid] = list;
        }
      }
      return {
        socketStatus: 'closed',
        sessionBusy: {},
        ...(changed ? { entries: settledEntries } : {}),
      };
    });
  },

  clearUserScope: () => {
    currentAuthEpoch++;
    get().disconnect();
    set({
      entries: {},
      sessionBusy: {},
      syncError: {},
      reconnectAttempt: 0,
    });
    for (const key of Object.keys(sessionRequestGen)) delete sessionRequestGen[key];
    for (const key of Object.keys(localRevision)) delete localRevision[key];
  },

  sendChat: async (sessionId, content) => {
    if (content.length > MAX_CHAT_CONTENT_LENGTH) {
      throw new Error(
        `Message exceeds maximum length of ${MAX_CHAT_CONTENT_LENGTH} characters.`,
      );
    }
    if (content.trim().length === 0) return;
    if (get().sessionBusy[sessionId]) {
      throw new Error('A turn is already in progress in this conversation. Please wait.');
    }

    const myAuthEpoch = currentAuthEpoch;
    const entry: ChatEntry = {
      key: nextKey(),
      role: 'user',
      content,
      ts: new Date().toISOString(),
      streaming: false,
      kind: 'text',
      status: 'sent',
    };

    localRevision[sessionId] = (localRevision[sessionId] ?? 0) + 1;
    set((s) => ({
      entries: { ...s.entries, [sessionId]: [...(s.entries[sessionId] ?? []), entry] },
      sessionBusy: { ...s.sessionBusy, [sessionId]: true },
    }));

    if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'chat', sessionId, content }));
      } catch (err) {
        if (myAuthEpoch !== currentAuthEpoch) return;
        set((s) => ({
          entries: {
            ...s.entries,
            [sessionId]: (s.entries[sessionId] ?? []).map((e) =>
              e.key === entry.key ? { ...e, status: 'unconfirmed' } : e,
            ),
          },
          sessionBusy: { ...s.sessionBusy, [sessionId]: false },
        }));
        throw err;
      }
    } else {
      // HTTP fallback turn
      const sentRevision = localRevision[sessionId];
      try {
        await api.post(`/chat/sessions/${sessionId}/messages`, { content });
        if (myAuthEpoch === currentAuthEpoch && localRevision[sessionId] === sentRevision) {
          set((s) => ({
            sessionBusy: { ...s.sessionBusy, [sessionId]: false },
            syncError: {
              ...s.syncError,
              [sessionId]:
                'Message queued via HTTP. Realtime turn status is unavailable; sync the transcript to check progress.',
            },
          }));
        }
      } catch (err) {
        // Auth epoch guard: do not recreate state if user logged out while request was in-flight
        if (myAuthEpoch !== currentAuthEpoch) return;
        const isExplicit = err instanceof ApiError;
        set((s) => ({
          entries: {
            ...s.entries,
            [sessionId]: (s.entries[sessionId] ?? []).map((e) =>
              e.key === entry.key ? { ...e, status: isExplicit ? 'failed' : 'unconfirmed' } : e,
            ),
          },
          sessionBusy: { ...s.sessionBusy, [sessionId]: false },
        }));
        throw err;
      }
    }
  },

  loadTranscript: async (sessionId) => {
    const myAuthEpoch = currentAuthEpoch;
    const reqGen = (sessionRequestGen[sessionId] = (sessionRequestGen[sessionId] ?? 0) + 1);
    const baseRev = localRevision[sessionId] ?? 0;

    let messages: ChatMessage[];
    try {
      const res = await api.get<{ messages: ChatMessage[] }>(
        `/chat/sessions/${sessionId}/messages`,
      );
      messages = res.messages;
    } catch {
      if (myAuthEpoch === currentAuthEpoch && reqGen === sessionRequestGen[sessionId]) {
        set((s) => ({
          syncError: { ...s.syncError, [sessionId]: 'Could not sync latest transcript.' },
        }));
      }
      return;
    }

    // Stale check: auth epoch changed, newer request arrived, OR realtime mutation occurred during fetch
    if (
      myAuthEpoch !== currentAuthEpoch ||
      reqGen !== sessionRequestGen[sessionId] ||
      (localRevision[sessionId] ?? 0) > baseRev
    ) {
      return;
    }

    set((s) => {
      if (
        myAuthEpoch !== currentAuthEpoch ||
        reqGen !== sessionRequestGen[sessionId] ||
        (localRevision[sessionId] ?? 0) > baseRev
      ) {
        return {};
      }
      const current = s.entries[sessionId] ?? [];
      const serverEntries: ChatEntry[] = messages.map((m) => ({
        key: nextKey(),
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
        ts: m.ts,
        streaming: false,
        kind: 'text' as const,
        status: 'sent' as const,
      }));

      const reconciled = reconcileTranscript(current, serverEntries);
      return {
        syncError: { ...s.syncError, [sessionId]: null },
        entries: {
          ...s.entries,
          [sessionId]: reconciled,
        },
      };
    });
  },

  clearLocal: (sessionId) => {
    sessionRequestGen[sessionId] = (sessionRequestGen[sessionId] ?? 0) + 1;
    localRevision[sessionId] = (localRevision[sessionId] ?? 0) + 1;
    set((s) => {
      const next = { ...s.entries };
      delete next[sessionId];
      const nextBusy = { ...s.sessionBusy };
      delete nextBusy[sessionId];
      const nextSync = { ...s.syncError };
      delete nextSync[sessionId];
      return { entries: next, sessionBusy: nextBusy, syncError: nextSync };
    });
  },
}));

type SetState = (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void;

/**
 * StreamEvent reducer: mutates the per-session transcript in place.
 * assistant_text fragments append to the streaming tail (or open a new one);
 * tool events render as inline status lines with typed toolStatus;
 * turn_finished closes the tail and schedules a single bounded snapshot reconciliation;
 * error renders as an assistant-side error entry.
 */
function handleStreamEvent(event: StreamEvent, set: SetState, get: () => ChatState): void {
  const { sessionId } = event;
  localRevision[sessionId] = (localRevision[sessionId] ?? 0) + 1;
  const entries = get().entries[sessionId] ?? [];

  switch (event.type) {
    case 'turn_started': {
      observedTurnStart.add(sessionId);
      set((s) => ({
        entries: {
          ...s.entries,
          [sessionId]: entries.map((e) =>
            e.streaming ? { ...e, streaming: false, interrupted: true } : e,
          ),
        },
        sessionBusy: { ...s.sessionBusy, [sessionId]: true },
      }));
      break;
    }
    case 'assistant_text': {
      const bodyIndex = entries.findIndex(
        (e) => e.role === 'assistant' && e.streaming && e.kind === 'text',
      );
      const last = entries[bodyIndex];
      if (last !== undefined) {
        const updated = [...entries];
        updated[bodyIndex] = {
          ...last,
          content: last.content + event.text,
        };
        set((s) => ({
          entries: { ...s.entries, [sessionId]: updated },
          sessionBusy: { ...s.sessionBusy, [sessionId]: true },
        }));
      } else {
        const entry: ChatEntry = {
          key: nextKey(),
          role: 'assistant',
          content: event.text,
          ts: event.ts,
          streaming: true,
          interrupted: !observedTurnStart.has(sessionId),
          kind: 'text',
        };
        set((s) => ({
          entries: { ...s.entries, [sessionId]: [...entries, entry] },
          sessionBusy: { ...s.sessionBusy, [sessionId]: true },
        }));
      }
      break;
    }
    case 'tool_started':
    case 'tool_finished': {
      const isStart = event.type === 'tool_started';
      const label = isStart
        ? `tool: ${event.toolName} …`
        : `tool: ${event.toolName} ${event.isError ? 'failed' : 'done'}`;
      const toolStatus: 'started' | 'done' | 'failed' = isStart
        ? 'started'
        : event.isError
          ? 'failed'
          : 'done';
      const entry: ChatEntry = {
        key: nextKey(),
        role: 'assistant',
        content: label,
        ts: event.ts,
        streaming: false,
        kind: 'tool',
        toolName: event.toolName,
        toolStatus,
        isError: !isStart ? event.isError : undefined,
      };
      set((s) => ({
        entries: { ...s.entries, [sessionId]: [...entries, entry] },
        sessionBusy: { ...s.sessionBusy, [sessionId]: true },
      }));
      break;
    }
    case 'turn_finished': {
      observedTurnStart.delete(sessionId);
      // Close all streaming entries for this session and release busy flag
      const settled = entries.map((e) => (e.streaming ? { ...e, streaming: false } : e));
      set((s) => ({
        entries: { ...s.entries, [sessionId]: settled },
        sessionBusy: { ...s.sessionBusy, [sessionId]: false },
      }));
      // Schedule one bounded snapshot load after terminal to sync persisted state once backend completes persist
      const targetSessionId = sessionId;
      const targetEpoch = currentAuthEpoch;
      const targetRevision = localRevision[sessionId];
      setTimeout(() => {
        if (
          currentAuthEpoch === targetEpoch &&
          localRevision[targetSessionId] === targetRevision
        ) {
          void get().loadTranscript(targetSessionId);
        }
      }, 350);
      break;
    }
    case 'error': {
      observedTurnStart.delete(sessionId);
      // Close all streaming entries and append error entry
      const settled = entries.map((e) => (e.streaming ? { ...e, streaming: false } : e));
      const entry: ChatEntry = {
        key: nextKey(),
        role: 'assistant',
        content: event.message,
        ts: event.ts,
        streaming: false,
        kind: 'error',
      };
      set((s) => ({
        entries: { ...s.entries, [sessionId]: [...settled, entry] },
        sessionBusy: { ...s.sessionBusy, [sessionId]: false },
      }));
      break;
    }
  }
}
