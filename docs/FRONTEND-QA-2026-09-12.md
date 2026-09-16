# Clawtide 页面修复与后端检查（2026-09-12）

## 范围

- 修改真实 React 前端，不替换成 OpenDesign 静态原型。
- 通过运行中的 OpenDesign 读取 Clawtide Coastal Integration 的完整设计包，沿用暖象牙、森林绿、柔和 teal、首屏操作和触控尺寸规范；没有触发 Cloud 生成或修改设计项目。
- 业务后端仅检查，未修改 src/、shared/，未读写真实 data 数据库。
- 原有 AGENTS.md、.codex/ 配置保留；未提交、推送或发布。

## 已修复

1. Chat 记录区与 Composer 的兄弟节点 key 重复：改为不同前缀，避免更新后残留重复记录区。空会话不再自动滚至底部或显示“Latest messages”。
2. 手机导航保留五项文字及至少 44px 触控区域；320px 无整页横向溢出。
3. Chat/Profile 侧栏支持遮罩、Esc、失焦关闭；打开定位输入，关闭恢复焦点，跨桌面/手机断点不将焦点留在隐藏区。
4. 空 Chat/Profile 提供直接开始/创建入口，最小高度 44px；320×650 登录按钮在首屏内。
5. Bootstrap 仅 401 进入未登录状态；网络、5xx、无效 JSON 显示可重试故障页。登录区分凭据错误与服务错误；退出失败提示并保留会话。
6. Setup 输入约束与服务端一致，补全自动填充及错误提示；初始化已完成时提供返回登录入口。
7. Workspace 使用写请求的真实返回更新列表，区分加载失败与操作失败；同步互斥及响应版本守卫防止旧 GET 覆盖新状态。

## 验证结果

运行时：Node v24.19.0，ABI 137。浏览器：真实 Chromium/Edge 页面。

- 完整 Vitest：23 文件、154/154 测试通过（新增 session 5 项、workspaceLoadGuard 2 项）。
- 项目类型检查、后端构建、前端类型检查与最终 Vite 生产构建：通过。
- 原有 scripts/smoke-loop5.mts：临时数据库真实 API 冒烟通过。
- 原有 scripts/visual-check.mjs：通过；覆盖草稿、任务表单、Profile 编辑、设置、短视口和减少动效。该脚本使用浏览器 fixtures，不代替真实后端联调。
- 独立真实后端页面验证：1440/390/320px 五个主页面无整页横向溢出；登录/启动/退出 503 注入、重试、侧栏遮罩/Esc、Chat/Profile 断点焦点、单一记录区/输入框、工作区延迟 GET 和写操作均通过；未捕获页面异常 0。
- 稳定截图复核：空 Chat 仅一个记录区；Profile 创建入口实测 44px，点击聚焦创建名称输入框。
- Prettier、git diff --check：通过。
- 全部数据操作使用 makeTestConfig 创建的隔离数据库；未配置外部模型提供商或运行真实用户任务。

## 实际分工与限制

- Luna low：前端定位、现有后端测试和 API smoke。
- Sol medium：前端实现及单元回归。
- Astra low：独立 diff 审查，指出旧列表覆盖与断点焦点问题。
- Astra medium：主代理整合、真实浏览器验收、修复浏览器先清空焦点的边界，以及关键终审、后端审查与独立复现。
- Antigravity CLI 已按官方安装器安装，保留 PATH/别名设置；实际 models 列表包含 Gemini 3.8 Flash medium 和 Claude Sonnet 4.6。
- 初次 Gemini 审查被安全审批阻止。用户随后明确允许发送临时页面截图和必要前端片段，现已完成真实 Gemini 3.8 Flash medium 只读补审，运行记录确认读取7张截图；未调用Claude。意见经主代理逐项核实，详见 [Gemini补审记录](GEMINI-UI-REVIEW-2026-09-12.md)。本次补审没有再次修改业务代码，不将模型建议冒充已修复结果。

## 后端优先改进项（未修复）

| 优先级 | 位置 | 已确认问题 | 建议 |
| --- | --- | --- | --- |
| 高 | src/ws.ts:130 | 合法 JSON null 帧在访问 type 时抛出未捕获 TypeError | 校验完整消息结构，隔离同步/异步回调异常 |
| 高 | src/auth-context.ts:65；src/ws.ts:142 | 注销撤销 HTTP 会话后，已建 WS 仍可触发聊天回调并接收用户广播 | 连接绑定可撤销会话，注销/过期后断开或重新验证 |
| 高 | src/task-scheduler.ts:561 | 租约续租失败只停心跳，执行器仍继续产生副作用 | 贯通取消机制，并在不可逆操作前校验/保证幂等 |
| 高 | src/server.ts:308；src/task-scheduler.ts:611 | 关闭服务未等待在途执行，数据库先关闭后仍有任务写入 | 停止接收、取消或限时等待、持久化终态，再关闭数据库 |

四项都经过真实处理器/内存数据库的隔离复现，主代理重复运行结果一致。退出码 0 表示成功复现缺陷，不表示后端已修复。真实网络下进程退出、真实 SDK 取消及信号关闭流程尚未端到端验证。

详细报告、复现脚本和浏览器证据保存在本次 Codex 输出目录：
C:/Users/ertstyuqk/.codex/visualizations/2026/09/11/01a08f6c-1881-7c90-98a3-43d532eb2360/
- backend-audit.md / backend-audit-repro.mts
- verify-live.mjs / probe-empty.mjs
- chat-fresh.png / profiles-empty.png / after-*.png

## 2026-09-16 前端提交验收

剩余前端修改整体检查后纳入提交，包括短屏聊天布局、侧栏焦点、登录/初始化错误处理、工作区响应竞态保护及对应测试。仅提交前端源码和 QA 文档，不包含本地 AGENTS.md、.codex 或 .agent 配置。

独立普通审查发现注销响应丢失后可能错误断言会话有效，现已修复：失败后查询 /auth/me；401 或空用户时断开 WS 并清理本地登录状态；无法确认时显示中性重试提示。真实 Edge 合成接口覆盖已撤销、无法确认和仍有效三态，均通过；定点复审无阻断发现。

本次 Web 类型检查、生产构建、前端源码 Prettier、完整 scripts/visual-check.mjs 页面交互回归通过，无 pageerror。27 组短屏/页面状态检查通过。全量 160 项测试已在同日上一提交前通过；本次新增注销分支以浏览器三态回归验证。测试使用模拟接口，不代表真实提供商、手机软键盘或屏幕阅读器验证。

较早文档中的“未提交”“未修复”是当时状态；后端 PR 修复已由 22ed308 提交，短屏后续证据及剩余工作见 PR-REVIEW-2026-09-14.md。
