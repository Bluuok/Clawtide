# Clawtide

![Clawtide — Make room for focus, ideas, and what matters.](docs/assets/clawtide-hero.gif)

[View the original artwork without animation](web/public/images/tidal-sculpture.png).

Self-hosted, multi-user AI digital-worker platform. Digital employees stay on
duty long-term through the Web console and IM channels — messages arrive
passively, scheduled tasks fire proactively — while identity, permissions, and
authentication are governed in the admin console.

> Derived from HappyClaw (https://github.com/riba2534) — MIT License,
> Copyright (c) 2025 riba2534. Architecture reimplemented; the upstream project
> was used as a mechanism reference under the terms of its MIT license. See
> [LICENSE](./LICENSE).

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

| Layer | Choice |
| --- | --- |
| Runtime | Node.js ≥ 20, ESM, TypeScript 5.9 strict |
| HTTP | Hono 4 + `@hono/node-server` |
| Realtime | `ws` 8 (native HTTP upgrade) |
| Storage | better-sqlite3 12 (single connection — the single-writer basis for lease atomicity) |
| Validation | zod 4 at every API boundary |
| Logging | pino (secret-bearing keys redacted) |
| Auth | bcryptjs(12) + node:crypto (HMAC / timingSafeEqual / AES-256-GCM) |
| Cron | cron-parser 5 (UTC, materialized occurrences) |
| Agent | `@anthropic-ai/claude-agent-sdk` (pinned) — the SDK owns the agentic loop |
| Channels | grammY (Telegram), `@larksuiteoapi/node-sdk` (Feishu) |
| Console | React 19 + Vite 7 + Tailwind CSS 4 + React Router + Zustand |

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

## Channel status — honest table

| Channel | Status | Evidence |
| --- | --- | --- |
| Telegram | **Connected for real** — grammY long-polling established against the live Bot API with an operator token (connection-level smoke `scripts/smoke-loop6-im.mts`); inbound→turn→reply verified by the same credential holder messaging the bot | `channels/telegram.ts` + `im-ingress.ts` |
| Feishu | **Connected for real** — official Node SDK WebSocket session established against the live open platform with an operator app (connection-level smoke); note: the app must enable 长连接 subscription mode in the developer console for event delivery | `channels/feishu.ts` + `im-ingress.ts` |
| QQ / DingTalk / WeChat / Discord / WhatsApp | Skeleton adapters — shell + capability declaration + mocked-transport contract tests, no SDK installed | `channels/channel-skeletons.ts` + `test/channels.test.ts` |

The Claude Agent SDK execution path is wired end-to-end and tested with
SDK-shaped frames; real model turns additionally require `ANTHROPIC_API_KEY`
(or a provider endpoint + key in Settings). Without a key, turns fail
loudly — a run records `failed`, never a fake success.

## Getting started

```bash
npm install          # root + web workspace
npm run dev          # server on 127.0.0.1:3000
npm run dev:web      # console dev server on :5173 (proxies to :3000)

npm run build && npm run build:web
npm test             # vitest
npm run typecheck && npm run typecheck:web
```

Open the console, run the one-time setup (the first user becomes admin),
then create workspaces, profiles, and tasks. `ANTHROPIC_API_KEY` (or a
provider endpoint + key in Settings) is required for real agent turns.

Environment: `PORT`, `HOST`, `DATA_DIR`, `TRUST_PROXY`,
`CORS_ALLOWED_ORIGINS`, `SESSION_TTL_DAYS`, `AUTH_MAX_ATTEMPTS`,
`AUTH_LOCKOUT_MINUTES`, `LOG_LEVEL` — zod-validated at boot. All timestamps
are stored as UTC ISO strings; SQLite data lives under `data/` (not in
Git), with automatic pre-migration backups and downgrade refusal.

## Docs

- [`docs/API.md`](./docs/API.md) — route families and semantics
- [`docs/ACL-MATRIX.md`](./docs/ACL-MATRIX.md) — endpoint × role × ownership matrix (admin's no-bypass is explicit)
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model: cookie forgery, brute force, privilege escalation, secret storage

## License

MIT — see [LICENSE](./LICENSE). This project retains the upstream
HappyClaw attribution notice required by its MIT license.
