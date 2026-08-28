# ACL-MATRIX — Workspace/身份权限矩阵（R20 实物）

端点 × 角色/归属 的操作矩阵。**列头「谁」= 账号 ownership；「角色」列仅用于 admin 独立闸（系统配置/用户管理），不影响 workspace 归属判定。** admin 对他人资源**无旁路**——这是 R20 的结构性事实：`rbac.ts` 三个判定函数签名收了 `role` 参数但逻辑从不使用它。

## 判定函数（src/rbac.ts）

```
canAccessGroup(user, ws) / canModifyGroup(user, ws) / canDeleteGroup(user, ws)
```

| 资源形态 | 判定 |
| --- | --- |
| is_home=1（Home） | 仅 owner 可见可改；**任何人不可删**（含 admin） |
| IM 组（jid 非 `web:`），created_by 非空 | created_by === user.id |
| IM 组 legacy（created_by 为空） | 同 folder 兄弟 home 反解 owner；**解不出 → deny by default** |
| Web 组（jid `web:`） | created_by === user.id |

## 端点矩阵

「A = 拥有该资源的用户」「B = 登录的其他用户」「admin = 登录的管理员」

| 端点 | 未登录 | B | A（owner） | admin（他人资源） |
| --- | --- | --- | --- | --- |
| `GET /healthz` | 200 | 200 | 200 | 200 |
| `POST /auth/setup` | 201（首个）/ 403 | — | — | — |
| `POST /auth/login` | 200 / 401 / 429 | — | — | — |
| `POST /auth/logout` | 200 | 200 | 200 | 200 |
| `GET /auth/me` | 401 | 200 | 200 | 200 |
| `GET /auth/users` | 401 | **403**（角色闸） | 403 | 200 |
| `POST /auth/users` | 401 | **403** | 403 | 201 |
| `DELETE /auth/users/:id` | 401 | 403 | 403 | 404（他人） |
| `GET /workspaces` | 401 | 仅可见资源 | 全部可见 | 仅 admin 自己可见 |
| `POST /workspaces` | 401 | 201 | 201 | 201 |
| `GET /workspaces/:id` | 401 | **404**（隐藏） | 200 | **404** |
| `PATCH /workspaces/:id` | 401 | **404** | 200 | **404** |
| `DELETE /workspaces/:id`（Home） | 401 | **404** | **403**（不可删） | **404** |
| `DELETE /workspaces/:id`（普通） | 401 | **404** | 200 | **404** |

关键点：越权一律 **404**，绝不给 403——存在性即信息。唯一例外是「自己能看见但操作被拒」的场景（Home 删除给 owner 403，配合会话可见性判断）。admin 的独立闸（`/auth/users`）给 403 而非 404，因为那不是"他人的资源"而是"角色不足"。