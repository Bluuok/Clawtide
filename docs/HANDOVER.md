# Clawtide — 施工交接文档（HANDOVER）

> 状态时间：2026-08-28 ｜ 真相源：`docs/REPLICATION-SPEC.md`（怎么建的最权威，先读它）
> 本文只回答两个问题：**下次从哪里开始**、**要做什么**。

## 0. 一句话

项目按 6 个 Loop 推进，每个 Loop 走 PLAN → IMPLEMENT → TEST → REVIEW → FIX → GATE，Gate 不过不进下一个。**Loop 0/1/2 已完成并推送到 GitHub，当前停在 Loop 3 门口。**

## 1. 当前真实状态（已验证）

- 分支 `main`，工作树干净，`origin = https://github.com/bfjxke/Clawtide`，已全部推送。
- 测试：**16 文件 / 106 用例全绿**；`typecheck`、`build`、`format:changed` 全过。
- GitHub Actions CI 在每次 push 后跑通（install → format-changed → typecheck → vitest → build）。

### 已完成的三个 Loop

| Loop | 内容 | 对应模块 | 状态 |
| --- | --- | --- | --- |
| Loop 0 | 工程地基：ESM+TS5.9 strict、Vitest、Hono+ws、zod 校验 config、pino 脱敏、SQLite 迁移框架、shared 单一类型源、CI、错误分类 | `config.ts` `db.ts` `logger.ts` `errors.ts` `web.ts` `ws.ts` `server.ts` `index.ts` `time.ts` `version.ts` + `shared/protocol.ts` | ✅ 推送 |
| Loop 1 | R19 认证全链 + R20 RBAC 三态 + IM Owner Gate | `auth.ts` `secrets.ts` `vault.ts` `rate-limit.ts` `rbac.ts` `owner-gate.ts` `auth-context.ts` + `stores/{users,workspaces}.ts` + `routes/{auth,workspaces}.ts` + 迁移 v2/v3 | ✅ 推送 |
| Loop 2 | Agent Runtime + R15 Profile | `agent-runtime.ts` `group-queue.ts` `prompt-plan.ts` + `stores/{agent-profiles,agent-sessions}.ts` + `routes/{profiles,chat}.ts` + `shared/stream.ts` + 迁移 v4 | ✅ 推送 |

### 已备好、留给后续 Loop 的接缝（不是半成品，是阶段边界）

- **WS 认证**：`WsHub` 的 `authenticator`（Loop 1 已接 cookie-session）；`wsSessionAuthenticator` 在 `auth-context.ts`。
- **WS chat 帧流式**：`WsHub.onChat` 已接到 runtime + RBAC（Loop 2）。
- **channel 表已建未接线**：`channel_accounts`（含 `credentials_enc`、`owner_im_id`、`default_workspace_id`）、`channel_mounts` 在迁移 v3，供 Loop 4 使用；`credentials.ts` 的 AES-256-GCM vault 是它的加密层。
- **`execution_mode` 保留列恒 `'host'`**（`workspaces`、`agent_sessions`），不实现 sandbox。
- **定时任务的落点**：`SerialQueue`（`group-queue.ts`）就是 R14 pump 要路由进的同一串行化点。

### 明确标记 NOT VERIFIED（原则：外部凭据不可用就如实标注，不 mock 过关）

- **Claude Agent SDK 真执行**：无 `ANTHROPIC_API_KEY`，从未跑过真实网络回合。映射层（SDK 帧→StreamEvent）、tool_events hook 路径、queue 串行、转写持久化都已被量形状 fixture 纯测。**填 `ANTHROPIC_API_KEY` 即可实跑**，接线就是 `executeTurn ?? defaultExecutor`。
- 未接任何真实 IM 渠道（那是 Loop 4）。

## 2. 下次从哪里开始：**Loop 3 — R14 定时调度器**

### Loop 3 的必备机制（逐条来自 spec §6.2，全部 MUST，无可选）

1. **物化 occurrence**：到期先物化出 `task_runs` 行，`occurrence_key`（如 `taskId:scheduledTimeISO`）UNIQUE 保证「该跑的一次只落一条」。立即运行走同一物化路径（幂等键+稳定 runId）→ 天然幂等。
2. **认领 = 单条条件 UPDATE**（SQLite 单写者原子）：
   ```
   UPDATE task_runs SET status='running', lease_owner=?, lease_token=<候选.token+1>,
         lease_expires_at=?, attempt=attempt+1
   WHERE id=? AND (
     (status IN ('queued','retry_wait') AND available_at <= ?)
     OR (status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND started_at IS NULL))
   ```
   用 `changes()>0` 裁决赢家。**SELECT 只找候选、不参与裁决**；`changes()===0` 就是没抢到。lease_token 是**自增整数**，认领 +1，完成/判失败再 +1 作废旧持有者。
3. **不可重入 = 两条 SQL 分支**：
   - 过期租约 + `started_at IS NULL`（认领了没真跑）→ 可被抢走重跑；
   - 过期租约 + `started_at IS NOT NULL` → 独立 `failExpiredStartedTaskRuns` 判 failed、释放租约、token+1，**不复活**。
4. **执行前校验**：置 `started_at` 的 UPDATE 带 `lease_expires_at > now` 且父任务 active 的 EXISTS 条件。
5. **心跳续租**：setInterval 条件更新 `SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?`；续租失败立刻停工；finally 清定时器。🔧 取值自定（如 租期 10min / 心跳 200s）+ 注释理由。
6. **重试**：安全预启动失败走 `releaseTaskRunForRetry`，延迟 `min(60s, 1s·2^(attempt−1))`，超 `MAX_SAFE_PRESTART_ATTEMPTS` 直接 failed。
7. **pump 循环**：setTimeout 自链、delay 上限钳到 `2^31−1`、`schedulerPumping` 布尔防重入、每轮限流条数。
8. **重启恢复**：启动扫持久化运行记录——错过的周期任务记 `missed` 并推进计划；once 任务仍补跑。**执行与通知分离**：`notification_lease_*` 独立租约，通知失败只重试通知不清任务。

### Loop 3 必备测试（一条都不能少）

- 同轮次两次认领只有一个赢家；
- 持锁中第二次认领落空；
- 租约过期**未开始** → 被抢；
- 租约过期**已开始** → 判 failed 不复活；
- 心跳续租失败 → 停工且他人可接管；
- `occurrence_key` 冲突 → 幂等跳过；
- `interval < 60` 被 CHECK 拒绝；
- 重启后 missed 推进 + once 补跑；
- **两个 scheduler 实例竞争**（同一 DB 并发 pump 只赢一次）。

### Loop 3 要建的模块/表（对照 spec §5）

- 迁移 v5：`scheduled_tasks`（workspace_id, prompt, schedule_type cron|interval|once, cron_expr, interval_seconds CHECK(>=60), run_at, context_mode group|isolated, status active|paused, deleted_at, created_by, created_at）+ `task_runs`（上述字段+occurrence_key UNIQUE+双组租约列）+ `task_run_logs`。
- `src/task-scheduler.ts`：pump/认领/心跳/重试/恢复/通知重试。
- 执行路径复用 `AgentRuntime` + `SerialQueue`（isolated=独立 Session，group=工作区共享会话）。
- 路由族：`routes/tasks.ts`（建 cron/interval/once 任务、列表、启停）。认证走既有 `sessionMiddleware` + RBAC（workspace 归属）。

## 3. 后续还有两个 Loop（快速预览，详细以 spec 为准）

- **Loop 4 — R07 七渠道统一抽象**：`im-channel.ts`（ImChannelAdapter 接口+统一 InboundMessage/OutboundContent+能力矩阵）、`im-manager.ts`（注册表+mount 解析）、`channels/`（telegram 真连 grammY 长轮询、feishu 真连、其余 5 渠道骨架+契约测试 mock 传输层）；`channel-mounts.ts` 绑定解析（群→Workspace、私聊→Session、原生线程→独立 Session）。README 诚实区分 verified/skeleton。
- **Loop 5 — Web 控制台 + 全链路 + 最终审查**：React(Vite+Tailwind) `web/` 包；setup/login/chat(流式/虚拟列表/断线重连)/profiles/tasks/settings；最后跑最终审查六步（Scope/Claim/Architecture/Security/Test/Manual Smoke）。

## 4. 施工规则备忘（每次开工必读）

- **真相源层级**：`REPLICATION-SPEC.md`（怎么建）＞ 文档口径 ＞ 参考仓库（只核对机制，**禁止逐文件复制**）。项目已更名 Clawtide，别叫 HappyClaw。
- **不做清单**：Docker/sandbox/第三 runner、MCP 管理、Skills 市场、RAG/向量/记忆、多 Agent 编排、Provider pool/failover、评测框架、计费、Owner reassign、对象级 ACL、CSRF、登录后重生成 session、分布式限流、验证码、PWA、i18n、工具强制策略引擎。**代码里一行都别出现（含注释掉的脚手架）**。
- **禁止 TODO/stub/fake/placeholder**；不通过删测试/降断言/mock 过关；外部凭据不可用标 `NOT VERIFIED`。
- **提交规约**：conventional commits、一个机制一串提交、禁止一把梭 import；每 Loop Gate 通过后 push（`git push` 到 origin/main）。
- **代码约定**：
  - 相对导入一律 `.js` 后缀（NodeNext ESM）；
  - 所有时间戳 UTC ISO sring（用 `time.ts` 的 `nowIso`）；
  - 所有 DB 访问走单一 `openDatabase`（`db.ts` 唯一入口）；迁移 append-only 放 `src/migrations/NNN-*.ts`，每个迁移配一条专项测试；
  - 前后端共享类型定义在 `shared/` 一次，禁止复制副本；
  - API 越权一律 404（存在性隐藏）；admin 无旁路（`rbac.ts` role 参数收而不用）；R15 发布 source 由认证上下文推导。

## 5. 质量门槛（每个 Loop 的 Gate）与最终审查

- 每 Loop Gate：`typecheck` / `vitest run` / `build` / `format:changed` 全绿 + 真实启动冒烟。
- 完成后（所有 Loop 之后）执行最终审查：Scope Review（无 TODO/残留）→ Claim Review（README/docs 每条 claim 对应源码+测试）→ Architecture Review（shared 单一源/DB 唯一入口/R14 原子竞争/R15 真实上下文/R20 ownership-admin 解耦/R07 隔离/统一 Runtime）→ Security Review（Cookie/HMAC/timingSafeEqual/限流/凭据加密/Secret/Owner Gate/404/日志脱敏）→ Test Review（format/typecheck/unit/integration/migration/build）→ Manual Smoke（登录/Profile 发布/任务触发/IM 渠道/越权/Owner Gate/重启恢复）。READ ME 已有：README 写稿（LOOP5）、ACL-MATRIX（√）、SECURITY（√）、API（√ 持续增长）。