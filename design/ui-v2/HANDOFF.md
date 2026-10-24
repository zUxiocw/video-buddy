# UI v2 · Claude Code 交接单

> 状态：**UI v2.1 等待用户验收；Claude Code 对接尚未开始。**
> 用户未明确同意前，不改 `.claude` 配置、不新增/修改 Claude Code 命令、不改插件代码。

## 这次的核心约束

- **优先保留插件技术栈成果**：Chrome MV3 + 原生 JS + Node 22 + Fastify + TypeScript。
- UI 不再假装“浏览器直连模型 API”。
- 刷视频限时是插件已有能力，UI 只呈现，不改 `limit*` 的额度、冷却、关页逻辑。
- Demo 悬浮球拖拽是展示层能力，不改 content script 的拖拽实现。
- 配置流程与现有 `serverUrl` + `appToken` 一致。
- 模型 Key 只在 `server/.env.local`。
- 不引入 React / Next / Vite 或第二套后端。

## 文件

- `site/`：可继续迭代的 UI 工作副本
- `design/ui-v2/`：本次冻结快照，不直接改
- `design/ui-v1/`：旧版，保留作对比；其直连 API 叙事已废弃
- `design/ui-v2/DESIGN.md`：设计规范
- `design/shangtou-meowmeow-ui-v2.zip`：交付包

## 若用户同意“UI 交接”

只做文档/命令层：

1. 让 Claude Code 读 `CLAUDE.md`、`DESIGN.md`、`HANDOFF.md`。
2. 输出一份“UI 与插件现状差异/风险清单”，不改代码。
3. 用户确认后，再把 UI 约束写进项目文档或自定义命令。

## 若用户同意“扩展 API 接入”

这是另一项工程，必须单独确认：

- 新增 `apiConfig` 不应悄悄替换现有 Fastify 链路。
- 需要先设计迁移路径：`serverUrl/appToken` 与 `apiConfig` 如何共存/迁移。
- 保留聊天 SSE、9 情绪、键盘隔离、主动搭话、历史记录、限时。
- 补齐 401/403/404/超时/限流的错误提示。
- 改完跑现有测试、扩展语法检查、e2e。

## 验收

- UI 交互测试：Demo 聊天/情绪/换视频、头像拖动/点击/方向键、限时预设/到点/关页/冷却/重置、下载弹窗、连接服务向导、保存配置、无运行时错误。
- 移动端 390px 检查；头像拖动后仍在手机屏幕内。
- 原服务端测试仍通过；本次 UI 未改服务端。
- 本次只改 `site/` 与 `design/`，未改 `extension/`、`server/`、manifest、content scripts。
