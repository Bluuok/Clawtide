/**
 * Chat: session picker + virtualized transcript + streaming composer.
 *
 * The transcript uses simple windowing (render only the tail while autoscroll
 * is engaged, full history on scroll-up) — enough to keep long sessions at a
 * bounded DOM count without a heavy virtualization dependency, while the
 * store keeps the entire transcript for copy/reference.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Session, type Workspace, type Profile } from '../api.js';
import { useChat, type ChatEntry, MAX_CHAT_CONTENT_LENGTH } from '../stores/chat.js';
import { useSession } from '../stores/session.js';
import { useMemoryDrafts } from '../stores/memoryDrafts.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { EmptyState } from '../components/Design.js';
import { useMobileSidebar } from '../hooks/useMobileSidebar.js';

/** Number of trailing entries rendered by default; grows as the user scrolls up. */
const WINDOW_STEP = 50;

export function ChatPage() {
  const user = useSession((s) => s.user);
  const userId = user?.id;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const sidebar = useMobileSidebar();
  const createSessionRef = useRef<HTMLSelectElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId);
  const activeWorkspace = workspaces.find((w) => w.id === activeSession?.workspaceId);
  const boundProfile = profiles.find((p) => p.id === activeSession?.profileId);

  // Subscribe specifically to the active session draft string to re-render without triggering list reloads
  const currentDraft = useMemoryDrafts((s) =>
    activeId ? (s.chatDrafts[userId || 'anon']?.[activeId] ?? '') : '',
  );

  const setDraft = (value: string) => {
    if (activeId !== null && mountedRef.current && useSession.getState().user?.id === userId) {
      useMemoryDrafts.getState().setChatDraft(userId, activeId, value);
    }
  };

  const loadLists = useCallback(async () => {
    const startEpoch = useMemoryDrafts.getState().authEpoch;
    setLoading(true);
    setError(null);
    try {
      const [{ sessions: ss }, { workspaces: ws }, profsRes] = await Promise.all([
        api.get<{ sessions: Session[] }>('/chat/sessions'),
        api.get<{ workspaces: Workspace[] }>('/workspaces'),
        api.get<{ profiles: Profile[] }>('/profiles').catch(() => ({ profiles: [] })),
      ]);

      if (!mountedRef.current || startEpoch !== useMemoryDrafts.getState().authEpoch) return;

      setSessions(ss);
      setWorkspaces(ws);
      setProfiles(profsRes.profiles);

      const saved = useMemoryDrafts.getState().getSelectedSession(userId);
      if (saved && ss.some((s) => s.id === saved)) {
        setActiveId(saved);
      } else {
        const nextId = ss[0]?.id ?? null;
        setActiveId(nextId);
        if (nextId) useMemoryDrafts.getState().setSelectedSession(userId, nextId);
      }
    } catch {
      if (mountedRef.current && startEpoch === useMemoryDrafts.getState().authEpoch) {
        setError('Could not load your conversations.');
      }
    } finally {
      if (mountedRef.current && startEpoch === useMemoryDrafts.getState().authEpoch) {
        setLoading(false);
      }
    }
  }, [userId]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const selectSession = (id: string) => {
    setActiveId(id);
    useMemoryDrafts.getState().setSelectedSession(userId, id);
    sidebar.close();
  };

  const createSession = async (workspaceId: string, profileId?: string) => {
    if (creating) return;
    const startEpoch = useMemoryDrafts.getState().authEpoch;
    setCreating(true);
    setError(null);
    try {
      const { session } = await api.post<{ session: Session }>('/chat/sessions', {
        workspaceId,
        ...(profileId ? { profileId } : {}),
      });

      if (!mountedRef.current || startEpoch !== useMemoryDrafts.getState().authEpoch) return;

      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
      useMemoryDrafts.getState().setSelectedSession(userId, session.id);
      sidebar.close();
    } catch {
      if (mountedRef.current && startEpoch === useMemoryDrafts.getState().authEpoch) {
        setError('Could not create a conversation. Please try again.');
      }
    } finally {
      if (mountedRef.current && startEpoch === useMemoryDrafts.getState().authEpoch) {
        setCreating(false);
      }
    }
  };

  const sessionBusy = useChat((s) => Boolean(activeId && s.sessionBusy[activeId]));

  const workerDisplay = activeSession
    ? activeSession.profileId
      ? boundProfile
        ? `Worker: ${boundProfile.name}`
        : `Worker: Unavailable worker (${activeSession.profileId.slice(0, 8)})`
      : 'Worker: Default worker (auto-resolved)'
    : null;

  return (
    <div className={`split-page chat-page ${sidebar.open ? 'sessions-open' : ''}`}>
      <button
        ref={sidebar.toggleRef}
        className="session-toggle"
        aria-expanded={sidebar.open}
        aria-controls="conversation-sidebar"
        onClick={sidebar.toggle}
      >
        <span>
          Conversations <span className="session-count">{sessions.length}</span>
        </span>
        <span>{sidebar.open ? 'Close −' : 'Browse +'}</span>
      </button>
      {sidebar.open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close conversations panel"
          onClick={() => sidebar.close()}
        />
      )}
      <SessionSidebar
        panelRef={sidebar.panelRef}
        searchRef={sidebar.primaryFocusRef}
        createRef={createSessionRef}
        sessions={sessions}
        workspaces={workspaces}
        profiles={profiles}
        activeId={activeId}
        onSelect={selectSession}
        onCreate={(wsId, profId) => void createSession(wsId, profId)}
        loading={loading}
        creating={creating}
      />
      <div className="chat-column">
        {error && (
          <p role="alert" className="mb-3 text-sm text-red-700">
            {error}
            <button className="ml-3 underline" onClick={() => void loadLists()}>
              Retry
            </button>
          </p>
        )}
        <header className="chat-heading">
          <div className="flex items-center justify-between">
            <div>
              <h2>{activeWorkspace?.displayName ?? 'Your next conversation'}</h2>
              {workerDisplay && (
                <span className="block mt-0.5 text-xs font-medium text-slate-500">
                  {workerDisplay}
                </span>
              )}
            </div>
            {sessionBusy && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs text-emerald-800"
                role="status"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                Working on a turn…
              </span>
            )}
          </div>
          <p>
            {activeId
              ? `Conversation ${activeId.slice(0, 8)} · A space for your next good idea.`
              : 'A little space to explore, plan, and make progress.'}
          </p>
        </header>
        {activeId !== null ? (
          <Transcript
            key={`transcript-${activeId}`}
            sessionId={activeId}
            onSuggestion={setDraft}
          />
        ) : loading ? (
          <div className="chat-loading" role="status">
            Opening your workspace…
          </div>
        ) : (
          <div className="empty-action">
            <EmptyState title="What is on your mind?" art="light">
              Choose a workspace to start a conversation with your digital worker.
            </EmptyState>
            <button
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
              onClick={() => sidebar.openAndFocus(createSessionRef.current)}
            >
              Start a conversation
            </button>
          </div>
        )}
        {activeId !== null && (
          <Composer
            key={`composer-${activeId}`}
            disabled={sessionBusy}
            onSend={async (text) => {
              await useChat.getState().sendChat(activeId, text);
            }}
            draft={currentDraft}
            setDraft={setDraft}
          />
        )}
      </div>
    </div>
  );
}

function SessionSidebar(props: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  searchRef: React.RefObject<HTMLElement | null>;
  createRef: React.RefObject<HTMLSelectElement | null>;
  sessions: Session[];
  workspaces: Workspace[];
  profiles: Profile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (workspaceId: string, profileId?: string) => void;
  loading: boolean;
  creating: boolean;
}) {
  const [query, setQuery] = useState('');
  const [newProfileId, setNewProfileId] = useState('');

  const filtered = [...props.sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((s) => {
      const name = props.workspaces.find((w) => w.id === s.workspaceId)?.displayName ?? '';
      return `${name} ${s.id}`.toLowerCase().includes(query.trim().toLowerCase());
    });

  return (
    <div
      ref={props.panelRef}
      className="list-panel conversation-sidebar"
      id="conversation-sidebar"
    >
      <div className="conversation-sidebar-head">
        <div className="conversation-sidebar-title">
          <span className="eyebrow">Conversations</span>
          <span className="session-count">{props.sessions.length}</span>
        </div>
        <input
          ref={props.searchRef as React.RefObject<HTMLInputElement | null>}
          type="search"
          aria-label="Find conversations"
          placeholder="Find a conversation…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="session-results min-h-0 flex-1 overflow-y-auto">
        {props.loading && (
          <p className="session-help" role="status">
            Loading conversations…
          </p>
        )}
        {!props.loading && filtered.length === 0 && (
          <p className="session-help">
            {query
              ? 'No matching conversations.'
              : 'A fresh start. Create your first conversation below.'}
          </p>
        )}
        {filtered.map((s) => (
          <button
            key={s.id}
            onClick={() => props.onSelect(s.id)}
            aria-pressed={s.id === props.activeId}
            aria-label={`Open conversation ${s.id}`}
            className={`block w-full px-3 py-2 text-left text-sm ${
              s.id === props.activeId ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'
            }`}
          >
            <span className="session-label block truncate">
              {props.workspaces.find((w) => w.id === s.workspaceId)?.displayName ??
                'Conversation'}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {new Date(s.updatedAt).toLocaleDateString()} · {s.id.slice(0, 6)}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-slate-200 p-2">
        <p className="session-help">
          {props.workspaces.length === 0 && !props.loading
            ? 'Create a workspace first to begin.'
            : 'Start something new'}
        </p>
        {props.profiles.length > 0 && (
          <select
            aria-label="Worker profile for new conversation"
            value={newProfileId}
            disabled={props.creating || props.loading}
            className="mb-1.5 w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
            onChange={(e) => setNewProfileId(e.target.value)}
          >
            <option value="">Worker: Default worker (auto)</option>
            {props.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                Worker: {p.name} {p.isDefault ? '(default)' : ''}
              </option>
            ))}
          </select>
        )}
        <select
          ref={props.createRef}
          disabled={props.creating || props.loading || props.workspaces.length === 0}
          aria-label="Create a conversation in workspace"
          className="mb-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value !== '') {
              props.onCreate(e.target.value, newProfileId || undefined);
              e.target.value = '';
            }
          }}
        >
          <option value="" disabled>
            {props.creating ? 'Creating…' : 'New conversation in…'}
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

function Transcript({
  sessionId,
  onSuggestion,
}: {
  sessionId: string;
  onSuggestion: (text: string) => void;
}) {
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [showLatest, setShowLatest] = useState(false);
  const entries = useChat((s) => s.entries[sessionId]);
  const loadTranscript = useChat((s) => s.loadTranscript);
  const syncError = useChat((s) => s.syncError[sessionId]);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    let current = true;
    setError(false);
    setLoading(true);
    pinnedRef.current = true;
    void loadTranscript(sessionId)
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    setWindowSize(WINDOW_STEP);
    return () => {
      current = false;
    };
  }, [sessionId, loadTranscript, retry]);

  const all: ChatEntry[] = entries ?? [];
  const visible = useMemo(() => all.slice(-windowSize), [all, windowSize]);
  const hiddenCount = all.length - visible.length;

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pinnedRef.current && visible.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setShowLatest(all.length > 0 && !pinnedRef.current);
    if (el.scrollTop <= 0 && hiddenCount > 0) {
      setWindowSize((w) => w + WINDOW_STEP);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="chat-transcript min-h-0 flex-1 overflow-y-auto"
      >
        {error && (
          <p role="alert" className="text-sm text-red-700">
            Could not load messages.{' '}
            <button className="underline" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </button>
          </p>
        )}
        {syncError && !error && (
          <p role="status" className="mb-2 text-xs text-amber-700">
            {syncError}{' '}
            <button className="underline" onClick={() => void loadTranscript(sessionId)}>
              Sync now
            </button>
          </p>
        )}
        {hiddenCount > 0 && (
          <div className="mb-3 text-center text-xs text-slate-400">
            ↑ {hiddenCount} earlier messages (scroll to top to load more)
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-6">
          {visible.map((e) => (
            <MessageBubble key={e.key} entry={e} />
          ))}
          {loading && visible.length === 0 && (
            <div className="chat-loading" role="status">
              Loading conversation…
            </div>
          )}
          {!loading && !error && visible.length === 0 && (
            <div className="chat-empty">
              <EmptyState title="Begin with a thought." art="light">
                Ask a question, explore an idea, or plan your next step.
              </EmptyState>
              <div className="suggestion-list">
                {[
                  'Help me plan a focused day.',
                  'Turn an idea into a clear plan.',
                  'Help me research a topic.',
                ].map((text) => (
                  <button key={text} onClick={() => onSuggestion(text)}>
                    {text}
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {all.length > 0 && showLatest && (
        <button
          className="latest-messages"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            pinnedRef.current = true;
            setShowLatest(false);
          }}
        >
          ↓ Latest messages
        </button>
      )}
    </div>
  );
}

function MessageBubble({ entry }: { entry: ChatEntry }) {
  const isUser = entry.role === 'user';
  const [copyState, setCopyState] = useState('Copy');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopyState('Copied');
    } catch {
      setCopyState('Copy unavailable');
    }
  };

  const isTool = entry.kind === 'tool';
  const isError = entry.kind === 'error';

  if (isTool) {
    const statusText =
      entry.toolStatus === 'started'
        ? '…'
        : entry.toolStatus === 'failed' || entry.isError
          ? 'failed'
          : 'done';
    const label = entry.toolName
      ? `${entry.toolName} ${statusText}`
      : entry.content.replace(/^tool:\s*/, '');
    return (
      <details className="tool-activity">
        <summary>
          Tool activity <span>{label}</span>
        </summary>
        <p>{entry.content}</p>
      </details>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`message-content max-w-[90%] whitespace-pre-wrap ${
          isUser
            ? 'message-user'
            : isError
              ? 'message-error border border-red-200 bg-red-50 text-red-800'
              : 'message-assistant'
        }`}
      >
        <div className="message-meta">
          {isUser ? 'You' : 'Clawtide'} ·{' '}
          {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {entry.status === 'failed' && (
            <span className="ml-2 font-medium text-red-600" role="status">
              · Failed to send
            </span>
          )}
          {entry.status === 'unconfirmed' && (
            <span className="ml-2 font-medium text-amber-600" role="status">
              · Unconfirmed
            </span>
          )}
        </div>
        {entry.interrupted ? (
          <details>
            <summary>Interrupted output — may be incomplete</summary>
            <MarkdownView content={entry.content} />
          </details>
        ) : isUser || isError ? (
          entry.content
        ) : (
          <MarkdownView content={entry.content} />
        )}
        {entry.streaming && (
          <span className="streaming-indicator" role="status">
            Writing
            <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-slate-400" />
          </span>
        )}
        {!entry.streaming && (
          <div className="message-actions">
            <button
              aria-label={`Copy ${isUser ? 'your' : 'assistant'} message`}
              onClick={() => void copy()}
              onBlur={() => setCopyState('Copy')}
            >
              {copyState}
            </button>
            <span className="sr-only" role="status">
              {copyState === 'Copy' ? '' : copyState}
            </span>
          </div>
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOverlength = props.draft.length > MAX_CHAT_CONTENT_LENGTH;

  const submit = async () => {
    const text = props.draft.trim();
    if (text.length === 0 || sending || props.disabled || isOverlength) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(text);
      props.setDraft('');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(
          'Send status unconfirmed (network error). Your draft is retained — please check your connection or retry.',
        );
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-composer">
      <div className="mx-auto max-w-3xl">
        {error && (
          <p role="alert" className="mb-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {isOverlength && (
          <p role="alert" className="mb-2 text-xs font-medium text-red-600">
            Message length ({props.draft.length.toLocaleString()} characters) exceeds the limit
            of {MAX_CHAT_CONTENT_LENGTH.toLocaleString()} characters. Please shorten it before
            sending.
          </p>
        )}
        <textarea
          aria-label="Message"
          disabled={sending}
          value={props.draft}
          onChange={(e) => {
            props.setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={
            props.disabled
              ? 'Digital worker is responding…'
              : 'A question, an idea, a next step…'
          }
          className="min-w-0 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <div className="composer-footer">
          <small>
            {props.disabled
              ? 'Turn in progress…'
              : 'Enter to send · Shift + Enter for a new line'}
          </small>
          <button
            onClick={() => void submit()}
            disabled={
              props.disabled || sending || props.draft.trim().length === 0 || isOverlength
            }
            className="self-end rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {sending ? 'Sending…' : props.disabled ? 'Busy…' : 'Send ↗'}
          </button>
        </div>
      </div>
    </div>
  );
}
