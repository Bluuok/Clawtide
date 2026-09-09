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
import { EmptyState } from '../components/Design.js';

/** Number of trailing entries rendered by default; grows as the user scrolls up. */
const WINDOW_STEP = 50;

export function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const activeSession = sessions.find((s) => s.id === activeId);
  const activeWorkspace = workspaces.find((w) => w.id === activeSession?.workspaceId);
  const setDraft = (value: string) => {
    if (activeId !== null) setDrafts((prev) => ({ ...prev, [activeId]: value }));
  };

  const loadLists = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ sessions: ss }, { workspaces: ws }] = await Promise.all([
        api.get<{ sessions: Session[] }>('/chat/sessions'),
        api.get<{ workspaces: Workspace[] }>('/workspaces'),
      ]);
      setSessions(ss);
      setWorkspaces(ws);
      setActiveId((prev) => prev ?? ss[0]?.id ?? null);
    } catch {
      setError('Could not load your conversations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const createSession = async (workspaceId: string) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const { session } = await api.post<{ session: Session }>('/chat/sessions', {
        workspaceId,
      });
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
      setSessionsOpen(false);
    } catch {
      setError('Could not create a conversation. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={`split-page chat-page ${sessionsOpen ? 'sessions-open' : ''}`}>
      <button
        className="session-toggle"
        aria-expanded={sessionsOpen}
        aria-controls="conversation-sidebar"
        onClick={() => setSessionsOpen(!sessionsOpen)}
      >
        <span>
          Conversations <span className="session-count">{sessions.length}</span>
        </span>
        <span>{sessionsOpen ? 'Close −' : 'Browse +'}</span>
      </button>
      <SessionSidebar
        sessions={sessions}
        workspaces={workspaces}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setSessionsOpen(false);
        }}
        onCreate={(id) => void createSession(id)}
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
          <h2>{activeWorkspace?.displayName ?? 'Your next conversation'}</h2>
          <p>
            {activeId
              ? `Conversation ${activeId.slice(0, 8)} · A space for your next good idea.`
              : 'A little space to explore, plan, and make progress.'}
          </p>
        </header>
        {activeId !== null ? (
          <Transcript key={activeId} sessionId={activeId} onSuggestion={setDraft} />
        ) : loading ? (
          <div className="chat-loading" role="status">
            Opening your workspace…
          </div>
        ) : (
          <EmptyState title="What is on your mind?">
            Choose a workspace to start a conversation with your digital worker.
          </EmptyState>
        )}
        {activeId !== null && (
          <Composer
            key={activeId}
            disabled={false}
            onSend={async (text) => {
              await useChat.getState().sendChat(activeId, text);
            }}
            draft={drafts[activeId] ?? ''}
            setDraft={setDraft}
          />
        )}
      </div>
    </div>
  );
}

function SessionSidebar(props: {
  sessions: Session[];
  workspaces: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (workspaceId: string) => void;
  loading: boolean;
  creating: boolean;
}) {
  const [query, setQuery] = useState('');
  const filtered = [...props.sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((s) => {
      const name = props.workspaces.find((w) => w.id === s.workspaceId)?.displayName ?? '';
      return `${name} ${s.id}`.toLowerCase().includes(query.trim().toLowerCase());
    });
  return (
    <div className="list-panel conversation-sidebar" id="conversation-sidebar">
      <div className="conversation-sidebar-head">
        <div className="conversation-sidebar-title">
          <span className="eyebrow">Conversations</span>
          <span className="session-count">{props.sessions.length}</span>
        </div>
        <input
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
        <select
          disabled={props.creating || props.loading || props.workspaces.length === 0}
          aria-label="Create a conversation in workspace"
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
    setShowLatest(!pinnedRef.current);
    // Scrolled to the top with history hidden → reveal more.
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
            <>
              <EmptyState title="Begin with a thought.">
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
            </>
          )}
        </div>
      </div>
      {showLatest && (
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
  const isTool = !isUser && entry.content.startsWith('tool:');
  if (isTool)
    return (
      <details className="tool-activity">
        <summary>
          Tool activity <span>{entry.content.slice(6)}</span>
        </summary>
        <p>{entry.content}</p>
      </details>
    );
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`message-content max-w-[90%] whitespace-pre-wrap ${
          isUser
            ? 'message-user'
            : entry.content.startsWith('⚠')
              ? 'message-error border border-red-200 bg-red-50 text-red-800'
              : entry.content.startsWith('tool:')
                ? 'border border-slate-200 bg-slate-100 font-mono text-xs text-slate-600'
                : 'message-assistant'
        }`}
      >
        <div className="message-meta">
          {isUser ? 'You' : 'Clawtide'} ·{' '}
          {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        {entry.content}
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
  const submit = async () => {
    const text = props.draft.trim();
    if (text.length === 0 || sending || props.disabled) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(text);
      props.setDraft('');
    } catch {
      setError('Message was not sent. Your draft is still here — please try again.');
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
        <textarea
          aria-label="Message"
          disabled={sending}
          value={props.draft}
          onChange={(e) => props.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="A question, an idea, a next step…"
          className="min-w-0 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <div className="composer-footer">
          <small>Enter to send · Shift + Enter for a new line</small>
          <button
            onClick={() => void submit()}
            disabled={props.disabled || sending || props.draft.trim().length === 0}
            className="self-end rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send ↗'}
          </button>
        </div>
      </div>
    </div>
  );
}
