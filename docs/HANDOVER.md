# Clawtide — 施工交接文档（HANDOVER）

> 状态时间：2026-08-29 ｜ 真相源：`docs/REPLICATION-SPEC.md`（怎么建的最权威，先读它）
> 本文只回答两个问题：**下次从哪里开始**、**要做什么**。

## 0. 一句话

项目按 6 个 Loop 推进，每个 Loop 走 PLAN → IMPLEMENT → TEST → REVIEW → FIX → GATE，Gate 不过不进下一个。**Loop 0–5 已全部完成并推送到 GitHub（React Web 控制台 + 最终审查 + README 均已交付），项目进入收尾维护状态。**

## 1. 当前真实状态（已验证）

- 分支 `main`，工作树干净，`origin = https://github.com/bfjxke/Clawtide`，已全部推送。
- 测试：**20 文件 / 143 用例全绿**；`typecheck`、`typecheck:web`、`build`、`build:web`、`format:changed` 全过。
- GitHub Actions CI 在每次 push 后跑通（install → format-changed → typecheck → vitest → build）。

### 已完成的六个 Loop

| Loop | 内容 | 对应模块 | 状态 |
| --- | --- | --- | --- |
| Loop 0 | 工程地基：ESM+TS5.9 strict、Vitest、Hono+ws、zod 校验 config、pino 脱敏、SQLite 迁移框架、shared 单一类型源、CI、错误分类 | `config.ts` `db.ts` `logger.ts` `errors.ts` `web.ts` `ws.ts` `server.ts` `index.ts` `time.ts` `version.ts` + `shared/protocol.ts` | ✅ 推送 |
| Loop 1 | R19 认证全链 + R20 RBAC 三态 + IM Owner Gate | `auth.ts` `secrets.ts` `vault.ts` `rate-limit.ts` `rbac.ts` `owner-gate.ts` `auth-context.ts` + `stores/{users,workspaces}.ts` + `routes/{auth,workspaces}.ts` + 迁移 v2/v3 | ✅ 推送 |
| Loop 2 | Agent Runtime + R15 Profile | `agent-runtime.ts` `group-queue.ts` `prompt-plan.ts` + `stores/{agent-profiles,agent-sessions}.ts` + `routes/{profiles,chat}.ts` + `shared/stream.ts` + 迁移 v4 | ✅ 推送 |
| Loop 3 | R14 调度器：物化 + 租约互斥 + 双分支过期 + 心跳 + 退避 + pump + 恢复 + 通知分离 | 迁移 v5 + `task-scheduler.ts` + `stores/tasks.ts` + `routes/tasks.ts` + `scripts/smoke-loop3.mts` | ✅ 推送 |
| Loop 4 | R07 七渠道：统一抽象 + 能力矩阵 + mount 解析 + 真连 2 + 骨架 5 | `im-channel.ts` `im-manager.ts` + `channels/{telegram,feishu,skeleton,channel-skeletons}.ts` + grammy/@larksuiteoapi 依赖 | ✅ 推送 |
| Loop 5 | Web 控制台（React 19 + Vite 7 + Tailwind 4，5 页面 + settings）+ settings 路由族 + 最终审查 + README + 冒烟脚本 | `web/`（npm workspace）+ `routes/settings.ts` + `scripts/smoke-loop5.mts` + README.md | ✅ 推送 |

### 已备好、留给 Loop 5 的接缝（不是半成品，是阶段边界）

- **WS 流式**：`WsHub.onChat` 已接 runtime + RBAC；`broadcastToUser(userId, StreamEvent envelope)` 是控制台聊天页要消费的事件流；`shared/stream.ts` 是前后端共享类型唯一源。
- **HTTP turn 兜底**：`POST /chat/sessions/:id/messages` 已把事件广播到该用户全部 WS 连接。
- **任务 API**：`/tasks`（list?workspaceId=）、`POST /tasks`、`GET /tasks/:id`（含 runs 历史）、`pause`/`resume`/`DELETE`/`run`（202 + runId，幂等）全部可用。
- **渠道表**：`channel_accounts`（`credentials_enc` AES-256-GCM 密文、`owner_im_id`）、`channel_mounts` 在迁移 v3；`ImManager.mount()` 是绑定的写入点。Loop 5 的 settings/渠道页如需展示「已配置与否」只查布尔，**不回显密文**。
- **认证**：`/auth/setup`（仅一次，首个用户 = admin）→ `/auth/login` → HttpOnly Cookie；`sessionMiddleware` 已覆盖全部业务路由前缀。
- **调度器**：`server.ts` 默认 `scheduler.start()`；测试可传 `schedulerAutoStart: false`。执行路径 = `executeRun` → AgentRuntime（isolated=新 Session，group=复用工作区最近 Session）。

### 明确标记 NOT VERIFIED（原则：外部凭据不可用就如实标注，不 mock 过关）

- **Claude Agent SDK 真执行**：无 `ANTHROPIC_API_KEY`。填 key 即实跑（接线 = `executeTurn ?? defaultExecutor`）；任务执行冒烟已验证「无 key 时 run 诚实记 failed，绝不假成功」。
- **Telegram / 飞书真实网络连接**：适配器代码 + 能力矩阵 + 契约测试已就位，但没有 bot token / 飞书应用凭据，长轮询与 WS 长连从未拨过真实网络。README 必须写「已验证渠道 / 骨架渠道」诚实表格（QQ/钉钉/微信/Discord/WhatsApp = 骨架 + mock 传输契约测试，无 SDK）。

### Loop 5 交付记录（2026-08-29 完成）

- **web/ 包**（npm workspace `clawtide-web`）：React 19 + Vite 7 + Tailwind 4 + React Router + Zustand；`shared/stream.ts`/`protocol.ts` 经 `@shared` 别名直接 import，零副本。
- **页面**：setup 向导 / login / chat（流式 + 尾窗虚拟化 + 指数退避重连带 jitter）/ profiles（四段编辑 + 版本历史 + restore + 两阶段确认短语）/ tasks（列表/创建/启停/run-now/runs）/ workspaces（Home 不可删）/ settings（Provider 端点 + 只写 key）。
- **新增路由族**：`/settings/provider` GET/PUT（admin 角色闸；key 只写不回显；持久化 > env > SDK 默认链，`AgentRuntime.deps.baseUrl` 每 turn 刷新 → SDK env `ANTHROPIC_BASE_URL`）。`docs/API.md` 已同步。
- **最终审查六步全部通过**：scope grep 无禁词（无 TODO/FIXME/stub 残迹，不做清单无越界）；claim/架构/安全/测试对照通过；`scripts/smoke-loop5.mts` 端到端 PASS（setup → profile → 草稿错短语作废 → WS 诚实 not-configured 错误流 → 任务诚实 failed → settings 只写 → 跨 owner 404）。
- **README.md** 自写完成：架构图、诚实渠道表（Telegram/飞书 NOT VERIFIED 标注）、无量化指标、保留上游 LICENSE 归属。

## 3. 施工规则备忘（每次开工必读）

- **真相源层级**：`REPLICATION-SPEC.md`（怎么建）＞ 文档口径 ＞ 参考仓库（只核对机制，**禁止逐文件复制**）。项目已更名 Clawtide，别叫 HappyClaw。
- **不做清单**（spec §8，一行代码都别出现，含注释掉的脚手架）：Docker/sandbox/第三 runner、MCP 管理、Skills 市场、RAG/向量/记忆、多 Agent 编排、Provider pool/failover、评测框架、计费、Owner reassign、对象级 ACL、CSRF、登录后重生成 session、分布式限流、验证码、PWA、i18n、工具强制策略引擎、备份工具链。
- **禁止 TODO/stub/fake/placeholder**；不通过删测试/降断言/mock 过关；外部凭据不可用标 `NOT VERIFIED`。
- **提交规约**：conventional commits、一个机制一串提交、禁止一把梭 import；每 Loop Gate 通过后 push（用户要求**每个阶段做完必须提交 GitHub**）。
- **代码约定**：
  - 相对导入一律 `.js` 后缀（NodeNext ESM）；
  - 所有时间戳 UTC ISO 字符串（用 `time.ts` 的 `nowIso`）；
  - 所有 DB 访问走单一 `openDatabase`（`db.ts` 唯一入口）；迁移 append-only 放 `src/migrations/NNN-*.ts`，每个迁移配一条专项测试；
  - 前后端共享类型定义在 `shared/` 一次，禁止复制副本；
  - API 越权一律 404（存在性隐藏）；admin 无旁路（`rbac.ts` role 参数收而不用）；R15 发布 source 由认证上下文推导，body 里的 source 字段一律不读。
- **工作循环**：用户已授权「每阶段完成 → 停下提交 GitHub → 自动继续下一阶段」。

## 4. 质量门槛（每个 Loop 的 Gate）

- 每 Loop Gate：`typecheck` / `typecheck:web` / `vitest run` / `build` / `build:web` / `format:changed` 全绿 + 真实启动冒烟。
- 本仓库已知坑（省后来人时间）：
  - better-sqlite3 STRICT 表：`lease_token` 等整型列必须 `NOT NULL DEFAULT 0`，插入缺列不会自动补；
  - cron-parser v5 必须 `tz: 'UTC'`（本地时区会偏移 fire time）且用 `prev()` 取「最近一个已到期槽位」（`next()` 永远在未来，物化扫描会扑空）；
  - 条件 UPDATE 的 WHERE 必须用**行内实时值**（`lease_token`），不能信调用方传入的 pre-claim 快照；
  - undici keep-alive 会挂住 `server.close()`，测试收尾必须 `closeAllConnections()`；
  - auth 测试要复现 HKDF：用 `loadOrCreateSecret` 走 `testKey()` helper，别手拼明文 secret；
  - npm workspaces + Vite：宿主仓的 vitest 依赖会把 vite 7 抬进根 node_modules，`web/` 的 vite 必须同样声明 ^7 否则插件类型冲突（plugin-react/tailwind 的 peer 挂在 vite 7 上）；
  - `ws` 客户端测试：事件处理器必须在 await 之前绑定（晚绑定会漏帧）；浏览器风格 `ws.onopen` 在 Node 环境不可靠，用 `ws.on('open', ...)`。
