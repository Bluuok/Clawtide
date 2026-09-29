# Architecture & implementation

[← Back to Clawtide](../README.md)

## Architecture

```
Agent Profile (R15: 4-segment prompt + capability policy)
└── Workspace (R20 resource: folder, channel-group binding, owner)
    ├── Runtime Session (conversation context; group / direct / native thread)
    └── Scheduled Run (R14: normal / isolated occurrence)

IM inbound:   adapter.onMessage → admission (Owner Gate / audience_mode)
              → mount resolution → session serial queue → agent turn
Scheduler:    pump → claim occurrence (lease) → same turn path
Web inbound:  REST/WS → cookie auth → RBAC → same turn path
```

One runtime, three entrances (spec: the scheduler's isolated runs, IM group
chats, and web chat all land on `AgentRuntime.sendMessage`).

| Layer      | Choice                                                                              |
| ---------- | ----------------------------------------------------------------------------------- |
| Runtime    | Node.js ≥ 20, ESM, TypeScript 5.9 strict                                            |
| HTTP       | Hono 4 + `@hono/node-server`                                                        |
| Realtime   | `ws` 8 (native HTTP upgrade)                                                        |
| Storage    | better-sqlite3 12 (single connection — the single-writer basis for lease atomicity) |
| Validation | zod 4 at every API boundary                                                         |
| Logging    | pino (secret-bearing keys redacted)                                                 |
| Auth       | bcryptjs(12) + node:crypto (HMAC / timingSafeEqual / AES-256-GCM)                   |
| Cron       | cron-parser 5 (UTC, materialized occurrences)                                       |
| Agent      | `@anthropic-ai/claude-agent-sdk` (pinned) — the SDK owns the agentic loop           |
| Channels   | grammY (Telegram), `@larksuiteoapi/node-sdk` (Feishu)                               |
| Console    | React 19 + Vite 7 + Tailwind CSS 4 + React Router + Zustand                         |

Two npm packages: the root server and `web/` (the console). Shared wire types
(`StreamEvent`, `WsEnvelope`) live in `shared/` and are imported by both —
defined once, never copied.

## Feature map

- **R14 — Occurrence-materialization scheduler** (`task-scheduler.ts`):
  due occurrences materialize as `task_runs` rows keyed by a UNIQUE
  `occurrence_key`; claiming is a single conditional UPDATE (SQLite
  single-writer makes it atomic — the SELECT only finds candidates,
  `changes()>0` decides); expired leases split into two SQL branches
  (never started → reclaimable; already started → failed, never revived);
  heartbeat renewal on `(owner, token)` with an incrementing
  `lease_token`; restart recovery marks missed cycles and re-runs `once`
  tasks; notification retries carry a separate lease so a failed
  notification never re-runs the task.
- **R15 — Four-segment agent profiles** (`prompt-plan.ts`,
  `agent-profiles.ts`): IDENTITY/SOUL/AGENTS/TOOLS stored and edited
  orthogonally; append/replace merge below an immutable platform preamble;
  immutable version snapshots with restore-as-new-version; a partial unique
  index keeps one active default per owner; AI-assisted drafts publish only
  after the user replies with an exact confirmation phrase — and the
  publish context is derived from the authenticated session, never from a
  client-supplied field, so scheduled/background callers have no publish
  surface at all.
- **R19 — Cookie authentication** (`auth.ts`, `rate-limit.ts`): bcrypt(12)
  → 64-hex opaque token → HMAC-SHA256 signature → `token.sig` cookie →
  constant-time comparison at the signature check (not the DB lookup);
  `__Host-`/plain dual cookie naming; two-layer login rate limiting
  (per-username+IP, plus a 4× global per-username window that a successful
  login deliberately does not reset); login audit trail; channel
  credentials encrypted with AES-256-GCM under a 0600 master key.
- **R20 — RBAC + IM Owner Gate** (`rbac.ts`, `owner-gate.ts`): tri-state
  ownership functions (access/modify/delete) where the `role` parameter is
  accepted but never read — admin has no bypass by construction; Home
  workspaces are undeletable by anyone; unresolvable legacy rows deny by
  default; cross-owner resources answer 404 (existence is not disclosed);
  IM messages from non-owners are dropped silently — no receipt, no error —
  so the gate cannot be probed.
- **R07 — Seven-channel abstraction** (`im-channel.ts`, `im-manager.ts`):
  one `ImChannelAdapter` interface + a declarative capability matrix drive
  degradation (e.g. WeChat is P2P-only in code, Telegram's 4096-char limit
  triggers adapter-side chunking); group chats bind to workspaces, direct
  chats and native threads to sessions, first occupancy persists.
