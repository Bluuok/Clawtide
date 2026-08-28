# SECURITY — 威胁模型与对策（R19/R20 动机）

简版安全视角：四个威胁面，逐条映射到实现与测试。

## 1. Cookie 伪造 / 会话劫持

- 登录签发 `crypto.randomBytes(32)` 64-hex opaque token，**不透明**——不存在可预测的部分。
- Cookie 值 = `token.sig`，`sig = HMAC-SHA256(sessionSecret, token)`。HMAC 是**防篡改兜底**，不是与 opaque token 并列的方案；数据库里的 token 仍是真相。
- 校验：`lastIndexOf('.')` → sig 必须 64 hex → 重算 HMAC → `Buffer` 等长后 `crypto.timingSafeEqual`。**常量时间比较在签名校验步**，不在数据库查找（不要被问到位置答错）。
- 密钥：`WEB_SESSION_SECRET` env → `data/config/session-secret.key`（0600）→ 首次自动生成。轮换 = 换 key + 清空 `user_sessions`（全员重登），干净操作无迁移。
- Cookie 属性：`HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`。HTTPS 请求 → `__Host-clawtide_session`（强制 Secure）；明文 HTTP → `clawtide_session`。伪造 `__Host-` 名在非 HTTPS 下**不生效**（服务端按请求安全性匹配合法名）。

测试：`auth.test.ts`（tamper/length/unsigned/__Host-）、`auth-api.test.ts`（Cookie 快照、logout 失效）。

## 2. 密码爆破 / 扫号

- 双层限流（`rate-limit.ts`）：
  - 层 1 `username:ip`，窗口 = lockoutMinutes，阈值 = AUTH_MAX_ATTEMPTS。
  - 层 2 `user:username` **跨 IP 全局**，阈值 = 层 1 × 4，固定 1h 窗。
  - **成功登录只清层 1**；层 2 留到 TTL 自然过期——防攻击者借合法登录重置全局计数。
- 客户端 IP：直连取 socket 地址；`TRUST_PROXY=true` 才信 `X-Forwarded-For`。
- 统一失败口径：用户不存在与密码错误同一响应，避免枚举。

测试：`rate-limit.test.ts`（fake-clock 驱动两层窗口/全局 4×/成功只清一层）、`audit.test.ts`（IP 来源、429 触发）。

## 3. 越权 / RBAC

- R20 三态判定 `rbac.ts`：rolex 参数收了但**逻辑不用**——admin 无旁路是结构，不是配置。
- 跨 owner 资源操作一律 404（存在性隐藏）；Home 任何人（含 admin）不可删；legacy（created_by 空）用兄弟 home 反解，解不出**默认拒绝**。
- 详情：`docs/ACL-MATRIX.md`。

测试：`rbac.test.ts`（矩阵全组合、admin 显式 false、legacy 两分支）、`auth-api.test.ts`（404 隐藏、Home 403/404）。

## 4. 敏感存储

- 密码 `bcryptjs(12)`；密钥/凭据列日志路径全部 redact（`logger.ts` REDACT_PATHS）。
- 渠道凭据 `AES-256-GCM`，主密钥 `data/config/vault-master.key`（0600 自动生成）；API 只回「已配置与否」。

测试：`auth.test.ts`（bcrypt、vault round-trip & tamper）。

## 演进方向（当前明确不做，代码无半成品）

- CSRF token、登录后 session 重生成、分布式限流、验证码、跨账号密码喷洒判定。
- 复用上一条口径：基础 Cookie 属性已有（HttpOnly+Secure+SameSite=Strict）；上述为演进路线。