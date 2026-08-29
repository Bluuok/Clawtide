# Clawtide — 施工交接文档（HANDOVER）

> 状态时间：2026-08-29 ｜ 真相源：`docs/REPLICATION-SPEC.md`（怎么建的最权威，先读它）
> 本文只回答两个问题：**下次从哪里开始**、**要做什么**。

## 0. 一句话

项目按 6 个 Loop 推进，每个 Loop 走 PLAN → IMPLEMENT → TEST → REVIEW → FIX → GATE，Gate 不过不进下一个。**Loop 0/1/2/3/4 已完成并推送到 GitHub，当前停在 Loop 5 门口（React Web 控制台 + 最终审查）。**

## 1. 当前真实状态（已验证）

- 分支 `main`，工作树干净，`origin = https://github.com/bfjxke/Clawtide`，已全部推送（最新 `d4cf0e9`）。
- 测试：**19 文件 / 140 用例全绿**；`typecheck`、`build`、`format:changed` 全过。
- GitHub Actions CI 在每次 push 后跑通（install → format-changed → typecheck → vitest → build）。

### 已完成的五个 Loop

| Loop | 内容 | 对应模块 | 状态 |
| --- | --- | --- | --- |
| Loop 0 | 工程地基：ESM+TS5.9 strict、Vitest、Hono+ws、zod 校验 config、pino 脱敏、SQLite 迁移框架、shared 单一类型源、CI、错误分类 | `config.ts` `db.ts` `logger.ts` `errors.ts` `web.ts` `ws.ts` `server.ts` `index.ts` `time.ts` `version.ts` + `shared/protocol.ts` | ✅ 推送 |
| Loop 1 | R19 认证全链 + R20 RBAC 三态 + IM Owner Gate | `auth.ts` `secrets.ts` `vault.ts` `rate-limit.ts` `rbac.ts` `owner-gate.ts` `auth-context.ts` + `stores/{users,workspaces}.ts` + `routes/{auth,workspaces}.ts` + 迁移 v2/v3 | ✅ 推送 |
| Loop 2 | Agent Runtime + R15 Profile | `agent-runtime.ts` `group-queue.ts` `prompt-plan.ts` + `stores/{agent-profiles,agent-sessions}.ts` + `routes/{profiles,chat}.ts` + `shared/stream.ts` + 迁移 v4 | ✅ 推送 |
| Loop 3 | R14 调度器：物化 + 租约互斥 + 双分支过期 + 心跳 + 退避 + pump + 恢复 + 通知分离 | 迁移 v5 + `task-scheduler.ts` + `stores/tasks.ts` + `routes/tasks.ts` + `scripts/smoke-loop3.mts` | ✅ 推送 |
| Loop 4 | R07 七渠道：统一抽象 + 能力矩阵 + mount 解析 + 真连 2 + 骨架 5 | `im-channel.ts` `im-manager.ts` + `channels/{telegram,feishu,skeleton,channel-skeletons}.ts` + grammy/@larksuiteoapi 依赖 | ✅ 推送 |

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

## 2. 下次从哪里开始：**Loop 5 — React Web 控制台 + 最终审查**

### 5.1 控制台（spec §2 地基行 + §6.5，MUST）

- 技术栈（spec §3 定版）：**React 19 + Vite + Tailwind CSS 4 + React Router + Zustand**（Radix 按需）。独立 `web/` 包，不做 SSR/PWA/i18n。
- 共享类型：`shared/stream.ts`（StreamEvent）与 `shared/protocol.ts` 由 web/ 直接 import，**禁止复制副本**。
- 页面最小面（MUST）：
  1. **setup 向导**（首用户 = admin，仅一次）→ 登录页。
  2. **chat**：流式渲染 + **虚拟化长列表** + **断线指数退避重连**（§5-10 防线三件套，一条都不能少）；消费 `stream` WS envelope。
  3. **profiles 编辑器 + 版本历史**（四段正交编辑、restore、两阶段草稿确认短语发布）。
  4. **tasks 页**（列表/建任务/启停/run-now/runs 历史）。
  5. **settings 最小**（Provider 单一 Anthropic 兼容端点配置，MUST-lite）。
- API 面：`docs/API.md`（已有文档，若新增路由同步更新）。

### 5.2 最终审查（spec §7，所有 Loop 之后的六步，逐条留痕）

1. **Scope Review**：全仓 grep 禁词（TODO/FIXME/stub/placeholder），§8 不做清单逐项确认无残迹（含注释掉的脚手架）。
2. **Claim Review**：README/docs 每条 claim 指到源码+测试。
3. **Architecture Review**：shared 单一源 / DB 唯一入口 / R14 原子竞争（两条 SQL 分支）/ R15 发布 source 推导 / R20 admin 无旁路（role 收而不用）/ R07 隔离 / 统一 Runtime（三条入站同一路径）。
4. **Security Review**：Cookie/HMAC/timingSafeEqual 位置 / 双层限流 / 凭据 AES-256-GCM / Secret 文件 0600 / Owner Gate 静默丢弃 / 404 越权 / 日志脱敏。
5. **Test Review**：format/typecheck/vitest/migration/build 全绿 + 每个选点必备测试清单对照。
6. **Manual Smoke**：登录 / Profile 发布 / 任务触发 / 越权 404 / Owner Gate / 重启恢复（脚本 `scripts/smoke-loop3.mts` 已可作任务冒烟的参考）。

### 5.3 README（Loop 5 交付物）

自写 README：架构图、**「已验证渠道 / 骨架渠道」诚实表格**、不出现任何编造量化指标（§9-12：效果全定性）；MIT 复用但保留原项目 LICENSE 归属声明（§9-10）。`docs/ACL-MATRIX.md`、`docs/SECURITY.md`、`docs/API.md` 已存在，随 Loop 5 路由增量同步。

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

- 每 Loop Gate：`typecheck` / `vitest run` / `build` / `format:changed` 全绿 + 真实启动冒烟。
- 本仓库已知坑（省后来人时间）：
  - better-sqlite3 STRICT 表：`lease_token` 等整型列必须 `NOT NULL DEFAULT 0`，插入缺列不会自动补；
  - cron-parser v5 必须 `tz: 'UTC'`（本地时区会偏移 fire time）且用 `prev()` 取「最近一个已到期槽位」（`next()` 永远在未来，物化扫描会扑空）；
  - 条件 UPDATE 的 WHERE 必须用**行内实时值**（`lease_token`），不能信调用方传入的 pre-claim 快照；
  - undici keep-alive 会挂住 `server.close()`，测试收尾必须 `closeAllConnections()`；
  - auth 测试要复现 HKDF：用 `loadOrCreateSecret` 走 `testKey()` helper，别手拼明文 secret。
