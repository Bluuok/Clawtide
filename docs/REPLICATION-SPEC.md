# Clawtide 复现文档（五选点子集 · 工业级成色）

> 生成日期：2026-08-25 ｜ 依据：`E:/zzzz/mini/HappyClaw-定稿.md`（面试口径真相源）+ `E:/zzzz/mini/happyclaw付费版内参/happyclaw-main`（参考实现，仅供机制查证）
> 用途：交给编码 AI 或自己开工的完整施工规格。**只复现五个选点（R07/R14/R15/R19/R20），但架构、测试、CI、文档等工程成色对标工业级开源项目。**
>
> **真相源层级**：本文件（怎么建）＞ `HappyClaw-定稿.md`（说什么话、什么红线）＞ 参考仓库源码（只用来核对机制细节，**不是逐文件克隆的模板**）。
> **标注约定**：✅＝已在参考源码核实（附出处）；🔧＝设计决策（自行定值，写出理由即可，面试报自己的取值，别背参考仓库的数）。

---

## 1. 目标与世界观

一句话：**自托管、面向多用户形态的 AI 数字员工平台**——数字员工通过 Web 与 IM 渠道长期在线值守（消息被动入口 + 定时主动入口），人设、权限、认证在管理后台治理。

- 「跨境电商客服/运营」是演示垂直场景（头罩话术，定稿 §5-1）：**只出现在简历和面试口径里，不进 README 功能承诺、不造假使用数据**。
- 产品三层模型（代码结构按此组织，与定稿 §2 世界观一致）：

```text
Agent Profile（身份：四段 Prompt + 能力策略）
└── Workspace（工作区：目录、渠道群聊绑定、归属人 created_by）
    ├── Runtime Session（对话上下文：主会话 / 私聊绑定会话 / 原生话题会话）
    └── Scheduled Run（定时任务的普通 / 隔离运行）
```

- 「多用户」= 设计目标话术：授权模型按多角色实现并用测试模拟越权验证（定稿 §5-3），**不造任何假的多租户运营数据**。

## 2. 复现范围总表

| 选点 | 复现内容 | 深度 |
| --- | --- | --- |
| R07 渠道抽象 | IMChannel 统一接口 + 统一消息模型 + 适配器注册表 + 能力矩阵 | MUST |
| R07 渠道 | Telegram 真连（grammY 长轮询）+ 飞书真连（WebSocket SDK） | MUST（Telegram 保底，飞书强烈建议） |
| R07 渠道 | 其余 5 渠道（QQ/钉钉/微信/Discord/WhatsApp）适配器骨架 + 契约测试（mock 传输层） | MUST-lite（撑「七渠道统一抽象」主张，对应防线 Part3 #15） |
| R07 渠道 | Telegram 长消息分片（渠道特有降级的样例）；斜杠命令最小集 `/list /where /bind /unbind` | 推荐（命令集喂 R20 Owner Gate 演示） |
| R07 渠道 | 流式卡片、Inbox/Outbox 可靠性状态机 | OPTIONAL（不做就整概念都不提） |
| R14 调度器 | 物化 occurrence + SQLite 租约互斥 + pump 循环 + 心跳续租 + 指数退避 + 重启恢复（missed/补跑）+ 执行/通知分离 | MUST，全保真 |
| R15 Profile | 四段存储 + append/replace + 版本历史 + is_default 部分唯一索引 + 两阶段 AI 起草 + 确认短语发布 + replace 保护平台段 | MUST（两阶段+确认短语在 bullet 里，不能缺） |
| R15 Profile | AI 局部优化润色 | OPTIONAL |
| R19 认证 | bcrypt(12) → 随机 token → HMAC 签名 → 常量时间比较 → 双名 Cookie → 双层限流 → 密钥文件管理 → 渠道凭据 AES-256-GCM → 登录审计日志 | MUST，全保真 |
| R19 认证 | 邀请码注册 | OPTIONAL（开放注册开关 + 首个用户=admin 为 MUST-lite） |
| R20 权限 | canAccess/Modify/DeleteGroup 三态 + admin 无旁路 + legacy 回退默认拒绝 + Home 不可删 + IM Owner Gate + audience_mode + 404 隐藏资源 | MUST，全保真 |
| R20 权限 | 所有权转移 reassign、对象级授权、运行时隔离 | **不做**（路线图口头，定稿 §5-5/Part3 #4/#8） |
| 地基 | Claude Agent SDK 会话运行（流式事件→WebSocket/渠道回执；工具调用事件留痕表） | MUST（防线 §5-8 的证据） |
| 地基 | Session 串行队列（同一会话顺序执行）、SQLite 迁移框架、pino 日志、zod 边界校验 | MUST |
| 地基 | Web 控制台最小面：setup 向导 / 登录 / chat（**流式渲染+虚拟化长列表+断线指数退避重连**，§5-10 防线三件套）/ profiles 编辑器+版本 / tasks 页 / settings 最小 | MUST |
| 地基 | Provider：单一 Anthropic 兼容端点配置（env 或设置页） | MUST-lite |

## 3. 技术栈定版（对齐参考仓库 package.json，✅ 已核实）

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 20，ESM（`"type": "module"`），TypeScript 5.9 strict | dev 用 tsx，build 用 tsc |
| HTTP | Hono ^4 + `@hono/node-server` | 路由族放 `src/routes/*.ts` |
| WebSocket | `ws` ^8（原生 HTTP Upgrade 握手） | 流式输出、断线重连都在这层 |
| 存储 | better-sqlite3 ^12（同步驱动、单连接） | **单写者是 R14 租约原子性的论证地基**；db.ts 是唯一访问入口 |
| 校验 | zod v4 | 所有 API 边界 |
| 日志 | pino（dev 加 pino-pretty） | 结构化字段：requestId/channel/taskId；凭据脱敏 |
| 认证 | bcryptjs（rounds=12 ✅ auth.ts:10）+ node:crypto（randomBytes/createHmac/timingSafeEqual/AES-256-GCM） | 不引 passport/jwt 库，链路自己写才讲得清 |
| Cron | cron-parser ^5 | 配合 TZ 环境变量说明时区语义 |
| Agent 运行时 | `@anthropic-ai/claude-agent-sdk` **锁定精确版本（不带 ^）** ✅ | 执行循环 SDK 托管，不自研（防线 §5-8） |
| 渠道 SDK | grammY（Telegram）、`@larksuiteoapi/node-sdk`（飞书 WebSocket） | 骨架渠道**不装 SDK**，传输层 mock 进契约测试 |
| Web | React 19 + Vite + Tailwind CSS 4 + React Router + Zustand（Radix 按需） | 不做 SSR/PWA |
| 质量 | Vitest、Prettier、GitHub Actions | 见 §7 门槛 |

**明确不用**：Bun、Express、ORM、JWT 库、Redis。包结构只做两个 npm 包：根（主服务）+ `web/`。
（参考仓库还有第三个包 `container/agent-runner`，那是为了 Docker 沙箱——沙箱是不选点，复现**不建第三个包**，SDK 进程内运行，这是一处有意偏离，面试也不用提容器。）

## 4. 架构与目录

```text
src/
├── index.ts              # 启动编排：迁移 → 调度器 → 渠道连接 → HTTP/WS
├── web.ts                # Hono 应用、路由挂载、Cookie 认证中间件、WS 升级
├── config.ts             # 设置优先级：Web 持久设置 > 环境变量 > 代码默认 ✅
├── db.ts                 # Schema、迁移（CURRENT_SCHEMA_VERSION）、访问器（唯一 DB 入口）
├── auth.ts               # R19 全部：哈希/token/HMAC/Cookie/限流/审计
├── rbac.ts               # R20：canAccessGroup / canModifyGroup / canDeleteGroup
├── owner-gate.ts         # R20：IM Owner Gate 判定链
├── task-scheduler.ts     # R14：pump、认领、心跳、重试、恢复
├── group-queue.ts        # Session 串行队列（序列化键内保序）
├── agent-runtime.ts      # Claude Agent SDK 封装：Session 创建/续接、流式事件分发
├── agent-profiles.ts     # R15：CRUD、版本、两阶段草稿、确认短语
├── prompt-plan.ts        # 四段 Prompt 组装（append/replace 语义、平台段保护）
├── im-manager.ts         # 适配器注册表与连接池（多用户多账号）
├── im-channel.ts         # R07：IMChannel 接口 + 统一消息模型 + 能力矩阵类型
├── channels/             # telegram.ts、feishu.ts + 5 个骨架适配器
├── channel-mounts.ts     # 绑定解析：群聊→Workspace、私聊→Runtime Session、原生线程→独立 Session
└── routes/               # auth / workspaces / profiles / tasks / channels / settings
web/                      # React 控制台（见 §2 地基行）
shared/                   # 前后端共享类型唯一源（StreamEvent 等）：定义一次，服务端与 web/ 直接 import，禁止复制副本
docs/                     # API.md、ACL-MATRIX.md（R20 面试实物）、SECURITY.md
data/                     # 运行数据，不进 Git（db/ config/ groups/ sessions/ ipc/）
```

**数据流（两条入口汇到同一条运行路径）**：

```text
IM 入站：渠道适配器.onMessage → admission（Owner Gate / audience_mode）→ mount 解析
        → Session 串行队列 → Agent 运行（SDK 流式）→ 出站交付（Web WS + 渠道 send）
定时入站：pump 循环 → 认领 occurrence（租约） → 同一条运行路径（isolated=独立 Session）
Web 入站：REST/WS → Cookie 认证 → RBAC 判定 → 同一条运行路径
```

## 5. 数据模型（核心表；✅ 列名为参考仓库核实，🔧 为补全）

```sql
-- R19 ✅（db.ts:833 起）
users(id, username UNIQUE, password_hash, role 'admin'|'member', created_at)
user_sessions(id, user_id, token, ip_address, user_agent, expires_at, created_at)  -- token 列唯一索引
auth_audit_log(id, ts, username, ip, event 'login_success'|'login_fail'|'rate_limited'|'logout', detail)

-- R15 ✅（db.ts:918 起，四段=四个列）
agent_profiles(id, owner_user_id, name,
  identity_prompt, soul_prompt, agents_prompt, tools_prompt,
  prompt_mode 'append'|'replace', version INTEGER, identity_hash,
  is_default INTEGER, status, created_at, updated_at)
-- ✅ 部分唯一索引：CREATE UNIQUE INDEX ... ON agent_profiles(owner_user_id) WHERE is_default=1 AND status='active'
agent_profile_prompt_versions(id, agent_profile_id, version, name, 四段快照..., created_at)  -- 历史不可变，恢复=写入新版本
profile_drafts(id, owner_user_id, draft_json, confirmation_phrase, expires_at, stage, created_at)  -- 🔧 两阶段草稿表

-- R14 ✅（db.ts:574/612 起）
scheduled_tasks(id, workspace_id, prompt, schedule_type 'cron'|'interval'|'once',
  cron_expr, interval_seconds CHECK(>=60), run_at, context_mode 'group'|'isolated',
  status 'active'|'paused', deleted_at, created_by, created_at)
task_runs(id, task_id, occurrence_key UNIQUE,          -- ✅ UNIQUE = 物化幂等的落点
  trigger_type, status 'queued'|'retry_wait'|'running'|'success'|'failed'|'missed'|'cancelled',
  attempt, available_at,
  lease_owner, lease_token INTEGER, lease_expires_at,   -- ✅ token 是自增整数，非随机串
  started_at, finished_at, result, error,
  notification_status, notification_lease_owner, notification_lease_expires_at)  -- ✅ 执行/通知分离各有租约
task_run_logs(task_id, run_at, status, duration_ms, error)  -- 历史

-- R20 ✅（web-context.ts 判定依赖的字段）
workspaces(id, folder UNIQUE, jid, display_name, is_home INTEGER, created_by FK users,
  execution_mode TEXT DEFAULT 'host', created_at)       -- execution_mode 保留字段，复现恒为 host
channel_accounts(id, user_id, channel, credentials_enc BLOB,  -- AES-256-GCM 密文
  owner_im_id, default_workspace_id, created_at)        -- ✅ owner_im_id 见 types.ts:136
channel_mounts(account_id, conversation_jid, kind 'group'|'direct',
  target_workspace_id, target_session_id)               -- 群→工作区、私聊→会话（✅ CLAUDE.md §6.2 边界）

-- 消息留痕（地基）
chats(chat_jid, workspace_id, kind), messages(id, chat_jid, role, content, ts, ...)
tool_events(id, message_id, tool_name, input_json, output_json, ts)  -- 防线 §5-8「副作用可追溯」的落点
```

**迁移协议**（✅ CLAUDE.md §7 要求备份/前向升级/拒绝降级）：`PRAGMA user_version` 存版本；升级前先把 db 文件复制进 `data/backups/`；`dbVersion > codeVersion` 直接启动失败并提示降级不受支持；每个迁移配一条迁移测试。

## 6. 五个选点实现规格

### 6.1 R19 · 认证与会话管理（先做，最独立）

**口径锚点**：定稿 §3.1-R19、防线 §5-11/§5-12、Q&A R19 组。Scope=Web 后台登录认证（你是谁），**不碰** Agent 运行时身份、不碰 IM 授权（那是 R20）。

机制链（全部 ✅ 核实自 `src/auth.ts`）：

1. **密码**：bcrypt rounds=12；用户名 `/^[a-zA-Z0-9_]{3,32}$/`，密码 8–128 位。
2. **签发**：`crypto.randomBytes(32).toString('hex')` → 64 字符 hex opaque token；入库 `user_sessions`；expires_at = now+30 天。
3. **HMAC 签名**：`HMAC-SHA256(secret, token)` hex，Cookie 值 = `` `${token}.${sig}` ``。**叙事定位：防篡改兜底，与 opaque token 不是并列方案**（防线 §5-12 最致命雷，代码注释里就把这句话写清楚）。
4. **校验**：`lastIndexOf('.')` 拆分 → sig 长度必须 64 → 重算 HMAC → `Buffer` 长度相等后 `crypto.timingSafeEqual` 比较。**常量时间比较发生在 HMAC 签名校验这一步**（auth.ts:74），不是数据库查找——面试别说错位置。
5. **Cookie**：HTTPS 请求 → `__Host-happyclaw_session`（带 Secure）；纯 HTTP（本地开发）→ `happyclaw_session`（✅ config.ts:53 双名策略，因为 `__Host-` 强制 Secure）。公共属性 `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`。
6. **密钥管理**：`WEB_SESSION_SECRET` env → 否则持久文件 `data/config/session-secret.key`（权限 0600）→ 否则首次自动生成并落盘。轮换 = 换 key + 清空会话表全体重登（防线 §5-12 的「干净操作」）。
7. **双层限流**（✅ auth.ts:126–231，注意精确机制）：
   - 第一层 key=`${username}:${ip}`，窗口=lockoutMinutes（运行时可配）；
   - 第二层 key=`user:${username}` 全局，阈值=第一层×4，窗口固定 1 小时；
   - 登录成功只清第一层记录，**全局层故意留到 TTL 自然过期**（auth.ts:225 注释：防攻击者借成功登录重置全局计数）；
   - 内存 Map + 每 10 分钟清理定时器，TTL 取 max(24h, 所有窗口)，key 按 firstAttempt 计算，定时器 `.unref()`。
   - 取客户端 IP：直连取 socket 地址；`TRUST_PROXY=true` 时才信 `X-Forwarded-For`（✅ CLAUDE.md §9）。
8. **加固配套**：渠道凭据 AES-256-GCM 加密列（主密钥文件 0600 自动生成），API 只返回「已配置与否」不回明文（✅ README 安全模型）；`auth_audit_log` 记登录成败/限流触发；API 对他人资源返回 404 而非 403（✅ CLAUDE.md §8，与 R20 共用）。

**必备测试**：篡改签名被拒；sig 非 64 长度被拒；默认拒收未签名旧 Cookie；伪造 `__Host-` 名在非 HTTPS 下不生效；vi.useFakeTimers 驱动限流窗口（首层耗尽/全局 4 倍边界/成功登录只清一层）；Cookie 属性快照断言。

### 6.2 R14 · Occurrence Materialization 定时调度器

**口径锚点**：定稿 §3.1-R14、防线 §5-2/§5-6/§5-7、Q&A R14 组、Part3 #1/#13。删了 V2 字样，面试不主动提版本史。

机制（✅ 除注明外均核实自 `src/db.ts` / `src/task-scheduler.ts`）：

1. **物化**：到期先生成 `task_runs` 行，`occurrence_key`（如 `taskId:scheduledTimeISO`）UNIQUE 约束保证「该跑的一次」只落一条记录；执行只是消费记录；立即运行走同一物化路径天然幂等（幂等键+稳定 runId ✅ README）。
2. **认领 = 条件更新**（db.ts:5363–5375 原句语义）：先 SELECT 候选，再
   ```sql
   UPDATE task_runs SET status='running', lease_owner=?, lease_token=<候选.token+1>,
         lease_expires_at=?, attempt=attempt+1
   WHERE id=? AND (
     (status IN ('queued','retry_wait') AND available_at <= ?)
     OR (status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND started_at IS NULL))
   ```
   `changes()>0` 者赢。SQLite 单写者保证原子。**SELECT 只找候选、不参与裁决**——抢没抢到只看这条 UPDATE 的受影响行数：SELECT 出来了但 `changes()===0` 就是没有赢；不得据 SELECT 结果认定归属，也不得在应用层再做一次『检查后再写』的第二判断。认领整体就是这一条语句（better-sqlite3 单语句天然原子），无需额外包事务。**lease_token 是自增整数**：认领 +1，完成/判失败再 +1 作废一切旧持有者。
3. **不可重入的落地是两条 SQL 路径**（关键细节）：
   - 过期租约 + `started_at IS NULL`（认领了但从没真正开跑）→ 可被抢走重跑；
   - 过期租约 + 已开始（`started_at IS NOT NULL`）→ 由独立的 `failExpiredStartedTaskRuns` 判 failed、释放租约、token+1，**不复活**（db.ts:5436）——「宁可错过不可重复」写在 SQL 里，不是口号。
4. **执行前再校验**：置 `started_at` 的 UPDATE 带 `lease_expires_at > now` 且父任务 active 的 EXISTS 条件（db.ts:5389–5401）——租约不新鲜或任务已删就不开跑。
5. **心跳续租**：setInterval 条件更新 `SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?`；续租失败立刻停工；finally 里清定时器（task-scheduler.ts:2270）。🔧 取值建议：租期 10 分钟、心跳=租期/3≈200s，写成常量+注释理由。
6. **重试**：安全预启动失败走 `releaseTaskRunForRetry`，延迟 `min(60s, 1s·2^(attempt−1))`，超 `MAX_SAFE_PRESTART_ATTEMPTS` 直接 failed（task-scheduler.ts:2239–2263）。
7. **pump 驱动**：setTimeout 自链循环（delay 上限钳到 2^31−1 内）、`schedulerPumping` 布尔防重入、每轮最多 drain N 条（通知重试循环每轮 8 条 ✅）。
8. **重启恢复**：启动时扫持久化运行记录——错过周期的周期任务记 `missed` 并推进计划；once 任务仍补跑（✅ CLAUDE.md §4）；执行与通知状态分离，**通知失败只重试通知不重跑任务**（notification_lease_* 独立租约 ✅）。

**必备测试**（这是效果槽「多实例互斥」的证据，一条都不能少）：同轮次两次认领只有一个赢家；持锁中第二次认领落空；租约过期未开始 → 被抢；租约过期已开始 → 判 failed 不复活；心跳续租失败 → 停工且他人可接管；occurrence_key 冲突 → 幂等跳过；interval<60 被 CHECK 拒绝；重启后 missed 推进 + once 补跑。

### 6.3 R15 · Agent Profile 四段式 Prompt

**口径锚点**：定稿 §3.1-R15、Q&A R15 组。AGENTS 段=声明性工作规则，**不是可执行编排引擎**——这句是 Scope 不是谦虚。

机制：

1. **四段正交**：IDENTITY/SOUL/AGENTS/TOOLS 各一列独立存取（✅ db.ts:923–926），改一段不动其他段。语义：我是谁 / 价值观底线 / 工作规则 / 工具策略。
2. **append/replace 双模式**（✅ `prompt_mode` 列默认 append）：实现位置在 **prompt-plan 组装层**——最终系统提示 = `[平台固定引导段] ⊕ profile 四段`。replace 只替换 profile 可编辑槽位，**平台段永远在最前、任何模式都覆盖不掉**（「平台运行时指令不可清除」的实现落点）；append 按序拼接。
3. **版本历史**：每次保存写入 `agent_profile_prompt_versions`（四段快照+版本号），历史不可变，「恢复」= 从历史版本内容写入**新**版本号；`identity_hash` 随内容变化，用于失效缓存的运行时（✅ 字段存在；复现中用于让进行中的会话下次 turn 拿到新 Prompt）。
4. **is_default 部分唯一索引**：每人同时只有一个激活的默认 Profile（✅ db.ts:941）——工业级细节，保留。
5. **两阶段 AI 辅助 + 确认短语**：阶段一 AI 起草存 `profile_drafts`（不生效）；阶段二用户逐字回复确认短语才发布。🔧 短语=随机可读 token（6–8 位）、草稿 15 分钟过期、短语比对失败即作废重来。**发布通道约束（来源从上下文推导，不信调用方自报）**：发布动作的合法性由执行上下文决定——Web 操作必须携带 Cookie 认证中间件解析出的已登录会话，IM 侧必须是入站 admission 链解析出的顶层交互会话；**API 一律不接受调用方传入的 source 字段作判据**。定时任务/Sub-Agent 背景路径的内部调用没有用户会话，认证/准入层直接 403（✅ README「定时任务与 Sub-Agent 不能代替用户发布」）——这条是确认短语防线的代码化，且闸门是结构性的（挂在现有认证/准入两层），不是参数约定。
6. **TOOLS 段消费**：作为工具策略声明注入 Prompt；工具调用的实际留痕走 `tool_events` 表（防线 §5-8）。

**必备测试**：replace 输出始终以平台段开头且平台段内容不被改写；append 保持段序；版本恢复产生新版本且历史行未被修改；is_default 二次设置违反部分唯一索引；短语不符/过期拒绝发布；无认证会话/非交互上下文的发布调用一律 403（含请求体自带 source 字段的伪造型用例）。

### 6.4 R20 · RBAC 三态 + IM Owner Gate

**口径锚点**：定稿 §3.1-R20、防线 §5-3/§5-4/§5-5、Q&A R20 组、Part3 #2/#4/#8。这是超档点，代码要经得起对着讲。

机制（判定函数 ✅ 全文核实自 `src/web-context.ts:358–419`）：

1. **三态函数组**：`canAccessGroup` / `canModifyGroup` / `canDeleteGroup`，输入 `{id, role}` × 资源 `{jid, is_home, folder, created_by}`：
   - `is_home` → 仅 owner 可见可改，**任何人不可删**（canDeleteGroup 对 is_home 恒 false）；
   - IM 组（jid 非 `web:` 前缀）→ created_by 命中即 true；created_by 存在但不匹配即 false；
   - legacy 行 created_by 为空 → 用同 folder 的兄弟 home 组反解归属；解不出 → **默认拒绝**（代码注释原话 deny by default）；
   - Web 组 → created_by 相等。
2. **admin 无旁路是结构性事实**：三个函数签名收了 `role` 参数但**逻辑完全不使用它**——admin bypass 在代码结构上不存在。面试可直接指给面试官看。admin 角色只用于另一道独立闸 `hasHostExecutionPermission`（Host 执行权限，✅ web-context.ts:347）和系统配置类 Permission Middleware——**所有权判定与角色闸是两套，不混**。
3. **IM Owner Gate 判定链**（防线 §5-4，D 判最重零防线雷）：消息到达 → 取渠道原生发送者 ID → 与工作区绑定的 `owner_im_id` 比对 → 不匹配则**拒执行且不回执**（防探测）；`owner_im_id` 在工作区创建/绑定渠道账号时写入（✅ types.ts:136/194）。破坏性 IM 命令受 `OWNER_REQUIRED_IM_COMMANDS` 清单 + 渠道原生 sender ID 双重约束（✅ CLAUDE.md §6.4）。audience_mode：`everyone` / `owner_only` 两态先做，`disabled` 顺带。
4. **跨渠道身份不归一**：同一人跨渠道按渠道账号各自绑定（防线 §5-4 尾句），代码上体现为 owner_im_id 挂在 channel_accounts 维度。
5. **资源隐藏**：跨 owner 的资源操作一律 404（与 R19 共享中间件行为）。
6. **明确不做**：reassign owner 所有权转移（口头路线图）、对象级（行内资源）授权、运行时隔离。**别留半成品**。

**必备测试**（表驱动矩阵）：roles×资源形态（home / 有主 IM / legacy 可反解 / legacy 不可反解 / web）×操作（access/modify/delete）全组合期望值；**显式断言 `canAccessGroup(admin, 别人的组) === false`**；legacy 反解成功/失败两分支；Owner Gate 不匹配 → 不投递不回执；Home 组删除被任何人（含 admin）拒绝。

### 6.5 R07 · 七渠道统一抽象

**口径锚点**：定稿 §3.1-R07、Q&A R07 组、Part3 #15。**关键认知：参考仓库里并没有一个字面上叫 IMChannel 的接口**——它是从 per-渠道文件有机生长出能力矩阵（`im-channel-capabilities.ts`）+ admission + mount 服务的。所以这个接口是**你在复现中显式设计的**，这恰恰就是 bullet 的主张（「设计了 IMChannel 统一接口」），别去临摹参考仓库的文件切分。

设计规格：

```ts
interface ImChannelAdapter {
  readonly channel: ChannelId;            // 'feishu'|'telegram'|'qq'|'dingtalk'|'wechat'|'discord'|'whatsapp'
  capabilities(): ChannelCapabilities;    // 声明式能力矩阵：媒体收发/话题线程/@控制/长消息分片/流式卡片…
  start(onInbound: (msg: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, content: OutboundContent): Promise<SendReceipt>;
}
// InboundMessage 统一消息模型：
// { channel, accountId, conversation:{kind:'group'|'direct', jid, threadId?}, senderId, text?, attachments[], messageId, ts }
```

1. **统一消息模型 + 适配器注册表**（im-manager）：Agent 核心只面向 InboundMessage/OutboundContent，渠道差异止步于适配器。
2. **能力矩阵驱动降级**：上层按 `capabilities()` 决定行为——例如无 `longMessageSplit` 的渠道由适配器内部分片（Telegram 4096 限制就是样例）；微信骨架的能力矩阵里 `supportsGroup=false`（iLink 仅 P2P ✅ README 渠道表）——**把「各渠道能力有差异，非功能完全一致」这条 Scope 变成代码里可见的事实**。
3. **真连两渠道**：Telegram（grammY 长轮询，无需公网回调，代理友好）必做；飞书（官方 Node SDK WebSocket 模式）强烈建议——对应画像「内部飞书协同」。
4. **骨架五渠道**：实现适配器壳 + 能力声明 + 契约测试（mock 传输层：给定该渠道的真实消息 payload fixture → 断言产出标准 InboundMessage；给定 OutboundContent → 断言产出正确的渠道 API 调用形状）。README 如实写「已验证渠道 / 骨架渠道」。
5. **mount 解析**：群聊→Workspace（多群可绑同一工作区）、私聊→指定 Runtime Session、飞书话题/Telegram Forum 原生线程→独立 Session（✅ CLAUDE.md §6.2/§6.3）；首次原生渠道占有 Session 后持久化，Web 后续回复沿用该渠道上下文。
6. OPTIONAL：斜杠命令最小集（`/list /where /bind /unbind`，写操作过 Owner Gate）；流式卡片；Inbox/Outbox 状态机。

**必备测试**：七渠道契约测试各一组（含微信 supportsGroup=false 的能力断言）；mount 解析表驱动；同序列化键消息保序（group-queue）。

## 7. 工程质量门槛（「工业级」的具体含义）

1. **类型与格式**：tsc strict 全仓零错误；Prettier + 「仅检查改动文件」脚本（对齐参考仓库 format:changed 思路）。
2. **测试**：Vitest；§6 各点必备测试全绿是合并门槛；迁移测试（升级+拒绝降级）。
3. **CI（GitHub Actions）**：install(npm ci) → format-changed → 类型一致性 → typecheck → vitest → build。PR 即使单人也要走分支+自查门槛——**提交历史本身是「工程素养」的展示面**：conventional commits、一个机制一串提交、禁止一把梭 import。
4. **日志**：pino 结构化（requestId/channel/taskId/userId）；凭据、token、密钥一律脱敏；错误带上下文不静默吞。
5. **配置**：zod 校验环境变量；设置优先级 Web 持久设置 > env > 代码默认（✅）；`CORS_ALLOWED_ORIGINS` 白名单、`TRUST_PROXY` 开关都要有。
6. **文档实物**（面试可展示）：自写 README（含架构图与「已验证渠道」诚实表格）；`docs/API.md` 路由族；**`docs/ACL-MATRIX.md` 权限矩阵**（端点×角色×归属的表格，R20 的最强实物证据）；简版 `SECURITY.md`（威胁模型：Cookie 伪造/爆破/越权，对应 R19/R20 动机）。
7. **数据卫生**：`data/` 进 .gitignore；lockfile 提交；engines 字段；时间一律 UTC ISO 字符串存储。

## 8. 明确不做清单（AI 最容易顺手加戏的地方，逐条禁止）

| 不做 | 理由 |
| --- | --- |
| Docker/容器沙箱、第三个 runner 包、镜像构建 | 未选点；引出一堆答不住的容器问题 |
| Provider 负载均衡池/故障转移/健康检查 | 未选点；单 Provider 配置足够 |
| MCP 管理、Skills 市场、Plugin catalog | 未选点（Craft 项目的地盘，别在这项目抢戏） |
| Workspace Memory / 任何记忆系统 | 定稿边界：知识靠上下文窗口+工具调用（防线 §5-9） |
| RAG/向量库/embedding | 同上，交底话术已备 |
| 评测底座/LLM 裁判/pass^k/基准集 | 定稿 §5-14：只做人工典型 Case 回归清单（可以是一个 markdown 用例表，不是代码系统） |
| 多 Agent 编排/Sub-Agent 系统 | 未选点 |
| 工具级强制策略引擎（allow/deny 强制拦截、高风险操作确认流、JS 层路径白名单） | 口径=SDK 托管+TOOLS 段声明式治理+tool_events 留痕（防线 §5-8）；JS 层路径限制可被符号链接/绝对路径绕过，属半成品——比缺失更危险 |
| 计费/用量报表/订阅兑换码 | 未选点 |
| reassign owner / 对象级授权 / CSRF token / 登录重生成 session / 分布式限流 / 验证码 | 全部是**口头演进方向**（定稿 §5-13、Part3），代码里不出现半成品 |
| 备份/恢复工具链、PWA、i18n | 性价比低且引来运维深挖 |

## 9. 关键提醒（口径 ↔ 实现 一致性，逐条都是审查踩过的坑）

1. **代码即证词**：简历与面试的每句 claim 必须能在代码里指出实现；反之，代码里每个机制你都得能讲。做完一块，回对一遍定稿 §3 bullet 和 §5 防线再进入下一块。
2. **⚠️ 已发现口径偏差——SameSite**：定稿防线 §5-13 把 SameSite 归入「第二层演进方向、未上」，但参考代码 Cookie 实际带 `SameSite=Strict`（auth.ts:86 ✅）。**建议：复现代码带上 HttpOnly+Secure+SameSite=Strict 三件套（零成本），并把 §5-13 口径微调为「基础 Cookie 属性已有；CSRF token 与登录后重生成 session 未做，是演进方向」**——比声称没做 SameSite 更防守。（✅ 2026-08-25 已同步定稿四处：talking R19 局限扩展 / §5-13 / Q&A R19 组 / Part3 #6。）
3. **限流要说准**：真实双层是「per-(用户名+IP) + 全局 per-用户名(4×阈值/1h 固定窗)」。talking 里「兼顾单 IP 扫号与单号爆破」要收敛为「同 IP 定点爆破 + 换 IP 续爆同一账号」；**跨账号密码喷洒是盲区**，被追就归入演进方向（与 Part3 #7 分布式限流同一出口）。
4. **常量时间比较的位置**：在 HMAC 签名校验（`crypto.timingSafeEqual`），不是数据库会话查找。Q19.1 背的时候把位置一起背对。
5. **lease_token 是自增整数**不是随机串；「认领+1、终结再+1」的双保险是亮点不是赘余——旧持有者即使还活着也写不进去。
6. **不可重入 = 两条 SQL 分支**（未开始可抢 / 已开始判死不复活），不是一句注释。R14 效果槽的全部证据就在这两条分支的测试里。
7. **admin 无旁路的最佳证据是「参数收了 role 但逻辑没用」**——写代码时刻意保持这个结构，并在 ACL-MATRIX.md 里给 admin 列如实打 ×。
8. **R07 接口是你的原创设计**：别照抄参考仓库文件名体系；接口形状、能力矩阵字段自己定，README 写清「统一抽象 + 能力差异显式声明」的设计取舍（对应 talking 的「抹平 vs 透传」权衡）。
9. **心跳间隔/租期数值报自己的**：🔧 定值（如 10min/÷3）+ 注释理由，面试答「我的设计取值」。参考仓库具体数值我没核实，**不要在面试里引用你没核实过的数**。
10. **命名与外观**：项目改名（别叫 HappyClaw）、目录与模块名自定、README 自己写——MIT 许可允许复用，但**保留原项目 LICENSE 归属声明**，仓库要呈现渐进生长的提交史而不是一次性导入。简历叙事里它是你的项目，仓库得像被人养出来的。
11. **半成品比缺失更危险**：§8 不做清单里的东西，代码里一行都别出现（包括注释掉的脚手架）——面试官顺着任何残迹追问都是新雷面。
12. **效果全定性**：README 和简历不出现任何编造的量化指标（QPS/准确率/用户数）；「验证过」的证据 = 测试套件 + ACL 矩阵 + 诚实的渠道验证表格。

## 10. 选点 ↔ 模块 ↔ 测试 ↔ 防线 映射（收口对照）

| Bullet | 模块 | 核心测试 | 定稿锚点 |
| --- | --- | --- | --- |
| R07 七渠道统一抽象 | im-channel.ts / im-manager.ts / channels/* / channel-mounts.ts | 七渠道契约测试、mount 表驱动、保序 | §3.1-R07、§5-1、Part3 #15 |
| R14 物化调度+租约互斥 | task-scheduler.ts / db.ts | 认领竞争、双分支过期、心跳失锁、幂等、恢复 | §5-2/§5-6/§5-7、Part3 #1/#13 |
| R15 四段式 Profile | agent-profiles.ts / prompt-plan.ts | 平台段保护、版本恢复、确认短语、403 后台发布 | Q15 组、防线 §5-8 |
| R19 Cookie 认证体系 | auth.ts / routes/auth | 篡改拒绝、限流窗口、Cookie 快照、审计 | §5-11/§5-12/§5-13、Part3 #5/#6/#7 |
| R20 RBAC 三态+Owner Gate | rbac.ts / owner-gate.ts | 权限矩阵全组合、admin 无旁路、legacy 默认拒、Gate 静默拒 | §5-3/§5-4/§5-5、Part3 #2/#4/#8 |

**验收定义（Definition of Done）**：§7 全部门槛绿 + 六组核心测试绿 + 手工冒烟（TG 发消息得回复、建 interval 任务按时触发、双账户演示越权 404、登录爆破触发限流、改人设走确认短语）+ README/ACL-MATRIX/SECURITY 三份文档成形。
