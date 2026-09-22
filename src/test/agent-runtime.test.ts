/**
 * Agent runtime — SDK frame → StreamEvent mapping, tool_events persistence,
 * transcript persistence, not-configured error path, and session create/resume.
 * Real network execution requires an API key (marked NOT VERIFIED here); the
 * mapping layer is tested with SDK-shaped frame literals.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db.js';
import { AgentRuntime, toStreamEvents } from '../agent-runtime.js';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '../../shared/stream.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import { pino } from 'pino';

const silent = pino({ level: 'silent' });

function makeRuntime(
  apiKey?: string,
  executeTurn?: NonNullable<ConstructorParameters<typeof AgentRuntime>[0]['executeTurn']>,
) {
  const config = makeTestConfig();
  const db = openDatabase({ config, logger: testLogger() });
  db.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'member', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('ws1', 'f1', 'web:f1', 'Ops', 0, 'u1', 'host', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  const runtime = new AgentRuntime({ db, logger: silent, apiKey, executeTurn });
  return { runtime, db, config };
}

describe('toStreamEvents mapping (pure, SDK-shaped frames)', () => {
  it('maps assistant text blocks to assistant_text events', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'tool_use', name: 'read' },
        ],
      },
    } as unknown as SDKMessage;
    const events = toStreamEvents('s1', msg);
    const texts = events.filter((e) => e.type === 'assistant_text');
    expect(
      texts.map((e) => (e as Extract<StreamEvent, { type: 'assistant_text' }>).text),
    ).toEqual(['hello ', 'world']);
  });

  it('maps a successful result to turn_finished and a failed result to error', () => {
    const ok = { type: 'result', subtype: 'success' } as unknown as Extract<
      SDKMessage,
      { type: 'result' }
    >;
    const err = { type: 'result', subtype: 'error_max_turns' } as unknown as Extract<
      SDKMessage,
      { type: 'result' }
    >;
    expect(toStreamEvents('s1', ok).map((e) => e.type)).toEqual(['turn_finished']);
    const errEvents = toStreamEvents('s1', err);
    expect(errEvents[0]!.type).toBe('error');
  });

  it('ignores non-streamed frame types (tool_progress handled via hooks)', () => {
    const tp = {
      type: 'tool_progress',
      tool_name: 'bash',
      tool_use_id: 'tid',
    } as unknown as SDKMessage;
    expect(toStreamEvents('s1', tp)).toEqual([]);
  });
});

describe('AgentRuntime lifecycle', () => {
  it('creates a session + transcript thread and reports isConfigured by apiKey', () => {
    const { runtime, config, db } = makeRuntime(undefined);
    try {
      expect(runtime.isConfigured()).toBe(false);
      const session = runtime.createSession({ workspaceId: 'ws1' });
      expect(session.sdk_session_id).toBeTruthy();
      expect(session.thread_id).toBeTruthy();
      const thread = db.db
        .prepare('SELECT * FROM chat_threads WHERE id = ?')
        .get(session.thread_id) as { kind: string };
      expect(thread.kind).toBe('direct');
      expect(runtime.sessionById(session.id)!.id).toBe(session.id);
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('without an API key the turn fails loudly via an error StreamEvent', async () => {
    const { runtime, db, config } = makeRuntime();
    try {
      const session = runtime.createSession({ workspaceId: 'ws1' });
      const events: StreamEvent[] = [];
      await runtime.sendMessage(session, 'hi', (e) => events.push(e));
      expect(events[0]!.type).toBe('turn_started');
      const error = events.find((e) => e.type === 'error');
      expect(error).toBeDefined();
      expect((error as Extract<StreamEvent, { type: 'error' }>).message).toContain(
        'not configured',
      );
      // both sides persisted: the user turn is on the transcript
      const msgs = runtime.messages(session.thread_id);
      expect(msgs.map((m) => m.role)).toEqual(['user']);
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('runs a turn through an injectable executor, persisting transcript + tool_events', async () => {
    const asyncGen = async function* (_params: unknown): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'lookup done' }] },
      } as unknown as SDKMessage;
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
    };
    const { runtime, db, config } = makeRuntime('test-key', (params) => asyncGen(params));
    try {
      const session = runtime.createSession({ workspaceId: 'ws1' });
      const events: StreamEvent[] = [];
      await runtime.sendMessage(session, 'look up SKU-1', (e) => events.push(e));
      expect(events.map((e) => e.type)).toContain('assistant_text');
      expect(events.map((e) => e.type)).toContain('turn_finished');

      const msgs = runtime.messages(session.thread_id);
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(msgs[1]!.content).toBe('lookup done');
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('records tool calls into tool_events via the PostToolUse hook path', async () => {
    // The injected executor reaches into the options the runtime built and
    // drives the PostToolUse hook exactly as the SDK would, proving the
    // wiring from hook input to tool_events row.
    const asyncGen = async function* (params: {
      prompt: string;
      options: Options;
    }): AsyncGenerator<SDKMessage> {
      const matchers = params.options.hooks?.PostToolUse;
      const callback = matchers?.[0]?.hooks[0];
      if (callback) {
        await callback(
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'lookup_sku',
            tool_use_id: 'tu-1',
            tool_input: { sku: 'SKU-1' },
            tool_response: { ok: true },
          } as never,
          undefined,
          { signal: new AbortController().signal },
        );
      }
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
    };
    const { runtime, db, config } = makeRuntime('test-key', (params) => asyncGen(params));
    try {
      const session = runtime.createSession({ workspaceId: 'ws1' });
      await runtime.sendMessage(session, 'look it up', () => undefined);
      const rows = db.db
        .prepare(
          'SELECT tool_name, input_json, output_json FROM tool_events WHERE session_id = ?',
        )
        .all(session.id) as Array<{
        tool_name: string;
        input_json: string;
        output_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tool_name).toBe('lookup_sku');
      expect(JSON.parse(rows[0]!.input_json)).toEqual({ sku: 'SKU-1' });
      expect(JSON.parse(rows[0]!.output_json)).toEqual({ ok: true });
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('passes the assembled R15 system prompt (platform ⊕ segments) to the SDK options', async () => {
    const seen: string[] = [];
    const asyncGen = async function* (params: {
      options: Options;
    }): AsyncGenerator<SDKMessage> {
      seen.push(String(params.options.systemPrompt ?? ''));
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
    };
    const { runtime, db, config } = makeRuntime('test-key', (params) => asyncGen(params));
    try {
      // Seed a replace-mode profile, then a session bound to it.
      db.db
        .prepare(
          `INSERT INTO agent_profiles (id, owner_user_id, name, identity_prompt, soul_prompt, agents_prompt, tools_prompt, prompt_mode, version, identity_hash, is_default, status, created_at, updated_at)
           VALUES ('pr1','u1','Ops','I am ops.','Be honest.','Follow runbook.','read-only','replace',1,'h',1,'active','t','t')`,
        )
        .run();
      const session = runtime.createSession({ workspaceId: 'ws1', profileId: 'pr1' });
      const profile = db.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get('pr1') as {
        identity_prompt: string;
        soul_prompt: string;
        agents_prompt: string;
        tools_prompt: string;
        prompt_mode: 'append' | 'replace';
      };
      const { buildSystemPrompt } = await import('../prompt-plan.js');
      const assembled = buildSystemPrompt(profile);
      await runtime.sendMessage(session, 'go', () => undefined, { systemPrompt: assembled });
      expect(seen[0]).toContain('You are an autonomous AI digital employee');
      expect(seen[0]).toContain('PROFILE MODE: replace');
      expect(seen[0]).toContain('I am ops.');
      expect(seen[0]).toContain('Follow runbook.');
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('serializes concurrent turns on the same session (order preserved)', async () => {
    const order: number[] = [];
    const asyncGen = async function* (_params: unknown): AsyncGenerator<SDKMessage> {
      await new Promise((r) => setTimeout(r, 20));
      yield 'marker' as unknown as SDKMessage;
    };
    const { runtime, db, config } = makeRuntime('test-key', (params) => asyncGen(params));
    try {
      const session = runtime.createSession({ workspaceId: 'ws1' });
      const emitTurn = (n: number) => (e: StreamEvent) => {
        if (e.type === 'turn_started') order.push(n);
      };
      await Promise.all([
        runtime.sendMessage(session, 'one', emitTurn(1)),
        runtime.sendMessage(session, 'two', emitTurn(2)),
        runtime.sendMessage(session, 'three', emitTurn(3)),
      ]);
      expect(order).toEqual([1, 2, 3]);
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });
});

describe('provider snapshot timing', () => {
  it('uses an immutable provider pair per turn and resolves queued turns when they start', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const seen: Options[] = [];
    const { runtime, db, config } = makeRuntime(undefined, async function* ({ options }) {
      seen.push(options);
      if (seen.length === 1) {
        entered();
        await gate;
      }
      yield { type: 'result', subtype: 'success' } as SDKMessage;
    });
    let current = { apiKey: 'first', baseUrl: 'https://first.invalid' };
    runtime.deps.resolveProvider = () => ({ ...current });
    try {
      const session = runtime.createSession({ workspaceId: 'ws1' });
      const first = runtime.sendMessage(session, 'first', () => {});
      await started;
      const second = runtime.sendMessage(session, 'second', () => {});
      current = { apiKey: 'second', baseUrl: 'https://second.invalid' };
      release();
      await Promise.all([first, second]);
      expect(seen.map((o) => [o.env?.ANTHROPIC_API_KEY, o.env?.ANTHROPIC_BASE_URL])).toEqual([
        ['first', 'https://first.invalid'],
        ['second', 'https://second.invalid'],
      ]);
    } finally {
      release();
      db.close();
      cleanupDir(config.dataDir);
    }
  });
});
