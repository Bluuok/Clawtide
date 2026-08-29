# API 概览（Loop 5 现状）

当前路由直接以 `/auth`、`/workspaces` 等为前缀（无 `/api` 层；路由族已定，保持现状）。错误统一为 `{ error: { code, message, requestId? } }`。

## 认证（R19）

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/setup` | 无 | 首个用户 = admin，全局仅一次（有用户后 403） |
| POST | `/auth/login` | 无 | 双层限流；成功 Set-Cookie 会话 |
| POST | `/auth/logout` | Cookie | 使会话失效并清 Cookie |
| GET | `/auth/me` | Cookie | 当前用户 `{id, username, role}` |
| GET | `/auth/users` | admin | 用户列表 |
| POST | `/auth/users` | admin | 建用户 `{username, password, role?}` |
| DELETE | `/auth/users/:id` | admin | 删除用户（不能删自己） |

## 工作区（R20）

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/workspaces` | Cookie | 可见工作区列表（自动过滤越权） |
| POST | `/workspaces` | Cookie | 建 Web 组 `{displayName, folder?}` |
| GET | `/workspaces/:id` | Cookie | 越权 → 404 |
| PATCH | `/workspaces/:id` | Cookie | 改名；越权 → 404 |
| DELETE | `/workspaces/:id` | Cookie | Home 不可删（403/404） |

## Profile（R15）

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/profiles` | Cookie | 我的 profile 列表（active） |
| POST | `/profiles` | Cookie | 建 profile `{name, segments{identity,soul,agents,tools}, promptMode}`；首个=默认 |
| GET | `/profiles/:id` | Cookie | 越权 404 |
| PATCH | `/profiles/:id` | Cookie | 改 name/单段/promptMode（未触及段保留）；version+1 |
| GET | `/profiles/:id/versions` | Cookie | 不可变版本历史 |
| POST | `/profiles/:id/default` | Cookie | 设为默认（部分唯一索引保证单默认） |
| POST | `/profiles/:id/restore` | Cookie | `{version}` 恢复=新版本 |
| POST | `/drafts` | Cookie | 两阶段阶段一：`{draftJson}` → 返回 confirmationPhrase |
| POST | `/drafts/:id/confirm` | Cookie | `{phrase}` 逐字确认发布；短语不符/过期即作废。**发布来源由会话推导，请求体 source 字段不被读取** |

## Chat / Agent Runtime（Loop 2）

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/chat/sessions` | Cookie | 建会话 `{workspaceId, profileId?}`（缺省用默认 profile） |
| GET | `/chat/sessions` | Cookie | 可见会话列表（RBAC 过滤） |
| GET | `/chat/sessions/:id/messages` | Cookie | 会话转写 |
| POST | `/chat/sessions/:id/messages` | Cookie | HTTP 回合：顺带向调用方打开的 WS 连接流式广播 |

WS `/ws` 认证后发 `{type:'chat', sessionId, content}` → 串行执行 → 流式 `StreamEvent`（`turn_started/assistant_text/tool_started/tool_finished/turn_finished/error`）按 user 广播。同一会话并发 turn 串行保序（`SerialQueue`）。工具调用落 `tool_events` 表。

## 系统

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | 存活探针 `{ok, version, uptimeSeconds}` |

## 设置（Loop 5）

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/settings/provider` | admin | `{provider: {baseUrl, configured}}`——**key 只写**：只回是否已配置，永不回显 |
| PUT | `/settings/provider` | admin | `{baseUrl, apiKey?}`；空 baseUrl 清除自定义端点；不带 apiKey 字段保留已存 key。member = 403（角色闸），未登录 = 401 |

## 登录限流语义

第一层（`username:ip`）耗尽 → `429 { code: 'rate_limited' }`；第二层（`user:username` 全局 1h）超 4× 阈值同理。测试与现值见 `docs/SECURITY.md`。

## WebSocket

`/ws` 升级点要求有效会话 Cookie；成功推送 `hello` 心跳包（`WsEnvelope`），客户端可发 `ping` 得 `pong`。