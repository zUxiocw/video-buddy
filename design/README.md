# 设计版本

## ui-v2（2026-10-24，待验收）

- 状态：已按插件技术栈重做，等待用户验收
- 原因：v1 假设浏览器直连模型 API，与现有 Fastify + APP_TOKEN 架构冲突
- 内容：公开版首页、交互 Demo、连接本地服务向导、扩展 + 本地服务安装说明
- 目录：`design/ui-v2/`
- 压缩包：`design/shangtou-meowmeow-ui-v2.zip`
- 校验：`design/shangtou-meowmeow-ui-v2.sha256`
- 设计说明：`design/ui-v2/DESIGN.md`
- 对接交接单：`design/ui-v2/HANDOFF.md`

## ui-v1（2026-10-24，已废弃直连 API 方案）

- 状态：保留作对比；其“浏览器直连模型 Key”流程不再采用
- 目录：`design/ui-v1/`
- 压缩包：`design/shangtou-meowmeow-ui-v1.zip`

## 约定

- 冻结快照不直接改。
- 新设计在 `site/` 迭代，确认后另存新版本。
- UI 是独立静态站点，不改 `extension/`、`server/` 或现有测试。
- 配置流程以现有 `serverUrl` + `appToken` 为准；模型 Key 留在 `server/.env.local`。
- Claude Code 对接需用户明确同意后再开始。
