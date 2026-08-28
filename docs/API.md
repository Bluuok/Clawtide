# API 概览（Loop 1 现状，持续增长）

当前路由直接以 `/auth`、`/workspaces` 为前缀（无 `/api` 层；待路由族增长时统一复核）。错误统一为 `{ error: { code, message, requestId? } }`。

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

## 系统

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | 存活探针 `{ok, version, uptimeSeconds}` |

## 登录限流语义

第一层（`username:ip`）耗尽 → `429 { code: 'rate_limited' }`；第二层（`user:username` 全局 1h）超 4× 阈值同理。测试与现值见 `docs/SECURITY.md`。

## WebSocket

`/ws` 升级点要求有效会话 Cookie；成功推送 `hello` 心跳包（`WsEnvelope`），客户端可发 `ping` 得 `pong`。