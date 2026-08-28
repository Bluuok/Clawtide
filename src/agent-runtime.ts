/**
 * Agent runtime — the single execution path (spec §4 data-flow: Web WS, IM,
 * and scheduler all land here). Owns session create/resume (continuation via
 * the persistent SDK session id), turn execution through the Claude Agent SDK,
 * SDK frame → StreamEvent mapping, downstream fan-out, the tool_events audit
 * trail, and the chat transcript.
 *
 * The SDK owns the agentic loop (防线 §5-8); this module is its slim shell.
 * Real network execution requires an API key (`ANTHROPIC_API_KEY` or any
 * SDK-supported env). Without one `isConfigured()` is false and turns fail
 * loudly via an `error` StreamEvent rather than pretending. The mapping layer
 * is pure and tested against SDK-shaped frames.
 */
import { randomBytes } from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, Options, HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { AppDb } from './db.js';
import type { Logger } from 'pino';
import { nowIso } from './time.js';
import type { StreamEvent } from '../shared/stream.js';
import type { WsEnvelope } from '../shared/protocol.js';
import { SerialQueue } from './group-queue.js';
import type { AgentSessionRow } from './stores/agent-sessions.js';

/** Delegatable turn boundary — the real SDK by default; injectable for tests. */
export type TurnExecutor = (params: {
  prompt: string;
  options: Options;
}) => AsyncGenerator<SDKMessage>;

export type StreamEmitter = (event: StreamEvent) => void;

export interface RuntimeDeps {
  db: AppDb;
  logger: Logger;
  apiKey: string | undefined;
  executeTurn?: TurnExecutor;
}

export class AgentRuntime {
  private readonly serial = new SerialQueue();

  constructor(private readonly deps: RuntimeDeps) {}

  isConfigured(): boolean {
    return this.deps.apiKey !== undefined && this.deps.apiKey.length > 0;
  }

  // ---- session lifecycle --------------------------------------------------

  /** New session + its transcript thread. `sdkSessionId` persists for resume. */
  createSession(params: { workspaceId: string; profileId?: string }): AgentSessionRow {
    const id = randomBytes(16).toString('hex');
    const threadId = randomBytes(16).toString('hex');
    const sdkUuid = crypto.randomUUID();
    const ts = nowIso();
    const insert = this.deps.db.db.transaction(() => {
      this.deps.db.db
        .prepare(
          "INSERT INTO chat_threads (id, workspace_id, kind, title, created_at) VALUES (?, ?, 'direct', '', ?)",
        )
        .run(threadId, params.workspaceId, ts);
      this.deps.db.db
        .prepare(
          'INSERT INTO agent_sessions (id, workspace_id, sdk_session_id, thread_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, params.workspaceId, sdkUuid, threadId, params.profileId ?? null, ts, ts);
    });
    insert();
    return this.sessionById(id)!;
  }

  sessionById(id: string): AgentSessionRow | undefined {
    return this.deps.db.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
      AgentSessionRow | undefined;
  }

  sessionsForWorkspace(workspaceId: string): AgentSessionRow[] {
    return this.deps.db.db
      .prepare('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY created_at')
      .all(workspaceId) as AgentSessionRow[];
  }

  messages(threadId: string): Array<{ role: string; content: string; ts: string }> {
    return this.deps.db.db
      .prepare('SELECT role, content, ts FROM chat_messages WHERE thread_id = ? ORDER BY ts')
      .all(threadId) as Array<{ role: string; content: string; ts: string }>;
  }

  // ---- turn execution -----------------------------------------------------

  /**
   * Run one user turn. Serializes per-session via SerialQueue so concurrent
   * turns over WebSocket on the same session execute strictly in order. Each
   * emitted StreamEvent is pushed to `emit`; tools are recorded to tool_events.
   * When a system prompt is supplied (assembled from the session's R15 profile:
   * platform ⊕ four segments), it is passed to the SDK, so profile edits reach
   * the model on the next turn.
   */
  sendMessage(
    session: AgentSessionRow,
    prompt: string,
    emit: StreamEmitter,
    opts?: { systemPrompt?: string },
  ): Promise<void> {
    return this.serial.enqueue(session.id, () => this.executeTurn(session, prompt, emit, opts));
  }

  private async executeTurn(
    session: AgentSessionRow,
    prompt: string,
    emit: StreamEmitter,
    opts?: { systemPrompt?: string },
  ): Promise<void> {
    const log = this.deps.logger.child({ sessionId: session.id, component: 'agent-runtime' });
    const started = nowIso();
    emit({ type: 'turn_started', sessionId: session.id, ts: started });
    this.persist(session.thread_id, session.id, 'user', prompt, started);

    if (!this.isConfigured()) {
      const ts = nowIso();
      emit({
        type: 'error',
        sessionId: session.id,
        message: 'agent runtime not configured: set ANTHROPIC_API_KEY',
        ts,
      });
      return;
    }

    let finished = false;
    const fragments: string[] = [];
    try {
      const executor = this.deps.executeTurn ?? defaultExecutor;
      const options: Options = {
        sessionId: session.sdk_session_id,
        maxTurns: 16,
        ...(opts?.systemPrompt !== undefined && opts.systemPrompt.length > 0
          ? { systemPrompt: opts.systemPrompt }
          : {}),
        env: {
          ANTHROPIC_API_KEY: this.deps.apiKey ?? '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        hooks: {
          PostToolUse: [
            {
              matcher: '*',
              hooks: [
                async (input: HookInput) => {
                  // PostToolUse matcher fires only for tool completions; narrow
                  // before reading tool fields.
                  if (input.hook_event_name === 'PostToolUse') {
                    this.recordToolUse(session.id, input);
                  }
                  return { hookEventName: 'PostToolUse', continue: true } as const;
                },
              ],
            },
          ],
        },
      };
      for await (const msg of executor({ prompt, options })) {
        for (const event of toStreamEvents(session.id, msg)) {
          emit(event);
          if (event.type === 'assistant_text') fragments.push(event.text);
          if (event.type === 'turn_finished') finished = true;
        }
      }
    } catch (err) {
      const ts = nowIso();
      emit({ type: 'error', sessionId: session.id, message: errorMessage(err), ts });
      this.deps.db.db
        .prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?')
        .run(ts, session.id);
      log.error({ err }, 'agent turn failed');
      return;
    }

    const done = nowIso();
    if (fragments.length > 0 && finished) {
      this.persist(session.thread_id, session.id, 'assistant', fragments.join(''), done);
    }
    this.deps.db.db
      .prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?')
      .run(done, session.id);
    if (!finished) {
      emit({
        type: 'error',
        sessionId: session.id,
        message: 'turn ended without a result frame',
        ts: done,
      });
    }
  }

  private recordToolUse(
    sessionId: string,
    input: { tool_name: string; tool_input: unknown; tool_response: unknown },
  ): void {
    this.deps.db.db
      .prepare(
        'INSERT INTO tool_events (session_id, tool_name, input_json, output_json, ts) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        sessionId,
        input.tool_name,
        safeJson(input.tool_input),
        safeJson(input.tool_response),
        nowIso(),
      );
    this.deps.logger.debug({ sessionId, toolName: input.tool_name }, 'tool use recorded');
  }

  private persist(
    threadId: string,
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    ts: string,
  ): void {
    this.deps.db.db
      .prepare(
        'INSERT INTO chat_messages (id, thread_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomBytes(16).toString('hex'), threadId, sessionId, role, content, ts);
  }
}

// ---------------------------------------------------------------------------
// Pure mapping: SDK frames → StreamEvents (fully testable without a network)
// ---------------------------------------------------------------------------

export function toStreamEventEnvelope(event: StreamEvent): WsEnvelope<StreamEvent> {
  return { type: 'stream', payload: event, ts: event.ts };
}

export function toStreamEvents(sessionId: string, message: SDKMessage): StreamEvent[] {
  switch (message.type) {
    case 'assistant': {
      const out: StreamEvent[] = [];
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.length > 0) {
          out.push({ type: 'assistant_text', sessionId, text: block.text, ts: nowIso() });
        }
      }
      return out;
    }
    case 'result': {
      const failed = message.subtype !== 'success';
      return failed
        ? [
            {
              type: 'error',
              sessionId,
              message: `turn failed (${message.subtype})`,
              ts: nowIso(),
            },
          ]
        : [{ type: 'turn_finished', sessionId, ts: nowIso() }];
    }
    default:
      // tool_progress / user / system frames are either handled via the hook
      // layer (tools) or not re-streamed to the console.
      return [];
  }
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function* defaultExecutor(params: {
  prompt: string;
  options: Options;
}): AsyncGenerator<SDKMessage> {
  yield* sdkQuery({ prompt: params.prompt, options: params.options });
}
