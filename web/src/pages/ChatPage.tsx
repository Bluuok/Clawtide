/**
 * Chat: session picker + virtualized transcript + streaming composer.
 *
 * The transcript uses simple windowing (render only the tail while autoscroll
 * is engaged, full history on scroll-up) — enough to keep long sessions at a
 * bounded DOM count without a heavy virtualization dependency, while the
 * store keeps the entire transcript for copy/reference.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Session, type Workspace } from '../api.js';
import { useChat, type ChatEntry } from '../stores/chat.js';

/** Number of trailing entries rendered by default; grows as the user scrolls up. */
const WINDOW_STEP = 50;

export function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const loadLists = useCallback(async () => {
    const [{ sessions: ss }, { workspaces: ws }] = await Promise.all([
      api.get<{ sessions: Session[] }>('/chat/sessions'),
      api.get<{ workspaces: Workspace[] }>('/workspaces'),
    ]);
    setSessions(ss);
    setWorkspaces(ws);
    if (activeId === null && ss.length > 0) setActiveId(ss[0]!.id);
  }, [activeId]);

  useEffect(() => {
    void loadLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createSession = async (workspaceId: string) => {
    const { session } = await api.post<{ session: Session }>('/chat/sessions', { workspaceId });
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  };

  return (
    <div className="flex h-full min-h-0">
      <SessionSidebar
        sessions={sessions}
        workspaces={workspaces}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={createSession}
      />
      {activeId !== null ? (
        <Transcript sessionId={activeId} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          Create or select a session to start.
        </div>
      )}
      {activeId !== null && (
        <Composer
          disabled={false}
          onSend={async (text) => {
            await useChat.getState().sendChat(activeId, text);
          }}
          draft={draft}
          setDraft={setDraft}
        />
      )}
    </div>
  );
}

function SessionSidebar(props: {
  sessions: Session[];
  workspaces: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (workspaceId: string) => void;
}) {
  return (
    <div className="flex w-64 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Sessions
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {props.sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => props.onSelect(s.id)}
            className={`block w-full px-3 py-2 text-left text-sm ${
              s.id === props.activeId ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'
            }`}
          >
            <span className="block truncate">Session {s.id.slice(0, 8)}</span>
            <span className="block truncate text-xs text-slate-400">{s.updatedAt}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-slate-200 p-2">
        <select
          className="mb-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value !== '') {
              props.onCreate(e.target.value);
              e.target.value = '';
            }
          }}
        >
          <option value="" disabled>
            New session in…
          </option>
          {props.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.displayName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Transcript({ sessionId }: { sessionId: string }) {
  const entries = useChat((s) => s.entries[sessionId]);
  const loadTranscript = useChat((s) => s.loadTranscript);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    void loadTranscript(sessionId);
    setWindowSize(WINDOW_STEP);
  }, [sessionId, loadTranscript]);

  const all: ChatEntry[] = entries ?? [];
  const visible = useMemo(() => all.slice(-windowSize), [all, windowSize]);
  const hiddenCount = all.length - visible.length;

  // Keep pinned to bottom while the user hasn't scrolled up; new stream
  // fragments arrive frequently, so this must not fight the user's scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // Scrolled to the top with history hidden → reveal more.
    if (el.scrollTop <= 0 && hiddenCount > 0) {
      setWindowSize((w) => w + WINDOW_STEP);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
      >
        {hiddenCount > 0 && (
          <div className="mb-3 text-center text-xs text-slate-400">
            ↑ {hiddenCount} earlier messages (scroll to top to load more)
          </div>
        )}
        <div className="mx-auto max-w-2xl space-y-3">
          {visible.map((e) => (
            <MessageBubble key={e.key} entry={e} />
          ))}
          {visible.length === 0 && (
            <div className="text-center text-sm text-slate-400">No messages yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ entry }: { entry: ChatEntry }) {
  const isUser = entry.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-slate-900 text-white'
            : entry.content.startsWith('⚠')
              ? 'border border-red-200 bg-red-50 text-red-800'
              : entry.content.startsWith('tool:')
                ? 'border border-slate-200 bg-slate-100 font-mono text-xs text-slate-600'
                : 'border border-slate-200 bg-white'
        }`}
      >
        {entry.content}
        {entry.streaming && (
          <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-slate-400 align-middle" />
        )}
      </div>
    </div>
  );
}

function Composer(props: {
  disabled: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSend: (text: string) => Promise<void>;
}) {
  const submit = async () => {
    const text = props.draft.trim();
    if (text.length === 0) return;
    props.setDraft('');
    await props.onSend(text);
  };
  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="mx-auto flex max-w-2xl gap-2">
        <textarea
          value={props.draft}
          onChange={(e) => props.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          className="min-w-0 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          onClick={() => void submit()}
          disabled={props.disabled || props.draft.trim().length === 0}
          className="self-end rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
