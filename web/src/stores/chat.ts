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
import { api, type ChatMessage } from '../api.js';

export interface ChatEntry {
  /** Client-side identity; server messages are keyed by role+ts on load. */
  key: string;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  /** Streaming: more fragments may still arrive for this entry. */
  streaming: boolean;
}

interface ChatState {
  socketStatus: 'connecting' | 'open' | 'closed';
  /** Attempts since last successful open — drives the backoff delay. */
  reconnectAttempt: number;
  /** sessionId → transcript entries for the virtualized list. */
  entries: Record<string, ChatEntry[]>;

  connect: () => void;
  disconnect: () => void;
  sendChat: (sessionId: string, content: string) => Promise<void>;
  loadTranscript: (sessionId: string) => Promise<void>;
  clearLocal: (sessionId: string) => void;
}

/** Socket + backoff plumbing lives outside the store: private mutable singletons. */
let ws: WebSocket | undefined;
let backoffTimer: ReturnType<typeof setTimeout> | undefined;
let explicitlyClosed = false;

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

export const useChat = create<ChatState>()((set, get) => ({
  socketStatus: 'closed',
  reconnectAttempt: 0,
  entries: {},

  connect: () => {
    if (ws !== undefined && ws.readyState <= WebSocket.OPEN) return;
    explicitlyClosed = false;
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }
    set({ socketStatus: 'connecting' });

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws = socket;

    socket.onopen = () => {
      // Reset the backoff ladder on any successful open (first or reconnect).
      set({ socketStatus: 'open', reconnectAttempt: 0 });
    };

    socket.onmessage = (ev) => {
      let envelope: WsEnvelope<unknown>;
      try {
        envelope = JSON.parse(String(ev.data)) as WsEnvelope<unknown>;
      } catch {
        return; // Malformed frame: ignore, never crash the console.
      }
      if (envelope.type === 'stream') {
        handleStreamEvent(envelope.payload as StreamEvent, set, get);
      }
      // hello / pong are transport-level; the socket being open is the signal.
    };

    socket.onclose = () => {
      ws = undefined;
      set({ socketStatus: 'closed' });
      if (explicitlyClosed) return;
      // Exponential backoff reconnect with jitter; attempt counter feeds the
      // delay and the UI banner ("reconnecting, attempt N").
      const attempt = get().reconnectAttempt;
      const delay = backoffDelay(attempt);
      set({ reconnectAttempt: attempt + 1 });
      backoffTimer = setTimeout(() => get().connect(), delay);
    };

    socket.onerror = () => {
      // onclose always follows onerror; the backoff chain lives there.
    };
  },
  disconnect: () => {
    explicitlyClosed = true;
    if (backoffTimer !== undefined) clearTimeout(backoffTimer);
    backoffTimer = undefined;
    ws?.close();
    ws = undefined;
    set({ socketStatus: 'closed' });
  },

  sendChat: async (sessionId, content) => {
    // Optimistic user entry; the server transcript will agree.
    const entry: ChatEntry = {
      key: nextKey(),
      role: 'user',
      content,
      ts: new Date().toISOString(),
      streaming: false,
    };
    set((s) => ({
      entries: { ...s.entries, [sessionId]: [...(s.entries[sessionId] ?? []), entry] },
    }));
    if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', sessionId, content }));
    } else {
      // HTTP fallback turn: same runtime path, streams back over the same WS
      // once reconnected, or lands in the transcript for the next load.
      await api.post(`/chat/sessions/${sessionId}/messages`, { content });
    }
  },

  loadTranscript: async (sessionId) => {
    const { messages } = await api.get<{ messages: ChatMessage[] }>(
      `/chat/sessions/${sessionId}/messages`,
    );
    set((s) => ({
      entries: {
        ...s.entries,
        [sessionId]: messages.map((m) => ({
          key: nextKey(),
          role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: m.content,
          ts: m.ts,
          streaming: false,
        })),
      },
    }));
  },

  clearLocal: (sessionId) => {
    set((s) => {
      const next = { ...s.entries };
      delete next[sessionId];
      return { entries: next };
    });
  },
}));

type SetState = (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void;

/**
 * StreamEvent reducer: mutates the per-session transcript in place.
 * assistant_text fragments append to the streaming tail (or open a new one);
 * tool events render as inline status lines; turn_finished closes the tail;
 * error renders as an assistant-side error entry.
 */
function handleStreamEvent(event: StreamEvent, set: SetState, get: () => ChatState): void {
  const { sessionId } = event;
  const entries = get().entries[sessionId] ?? [];

  switch (event.type) {
    case 'turn_started': {
      // The user message is already appended optimistically by sendChat.
      break;
    }
    case 'assistant_text': {
      const last = entries.at(-1);
      if (last !== undefined && last.role === 'assistant' && last.streaming) {
        const updated = entries.slice(0, -1).concat({
          ...last,
          content: last.content + event.text,
        });
        set((s) => ({ entries: { ...s.entries, [sessionId]: updated } }));
      } else {
        const entry: ChatEntry = {
          key: nextKey(),
          role: 'assistant',
          content: event.text,
          ts: event.ts,
          streaming: true,
        };
        set((s) => ({ entries: { ...s.entries, [sessionId]: [...entries, entry] } }));
      }
      break;
    }
    case 'tool_started':
    case 'tool_finished': {
      // Inline status line: tools are recorded server-side in tool_events;
      // the console shows the activity without asserting on outputs.
      const label =
        event.type === 'tool_started'
          ? `tool: ${event.toolName} …`
          : `tool: ${event.toolName} ${event.isError ? 'failed' : 'done'}`;
      const entry: ChatEntry = {
        key: nextKey(),
        role: 'assistant',
        content: label,
        ts: event.ts,
        streaming: false,
      };
      set((s) => ({ entries: { ...s.entries, [sessionId]: [...entries, entry] } }));
      break;
    }
    case 'turn_finished': {
      const last = entries.at(-1);
      if (last !== undefined && last.streaming) {
        const updated = entries.slice(0, -1).concat({ ...last, streaming: false });
        set((s) => ({ entries: { ...s.entries, [sessionId]: updated } }));
      }
      break;
    }
    case 'error': {
      const entry: ChatEntry = {
        key: nextKey(),
        role: 'assistant',
        content: `⚠ ${event.message}`,
        ts: event.ts,
        streaming: false,
      };
      set((s) => ({ entries: { ...s.entries, [sessionId]: [...entries, entry] } }));
      break;
    }
  }
}
