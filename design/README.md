# 设计版本

## ui-v3（3.0.0，2026-10-24，待验收）

- 状态：BYOK 网页已改完，等待验收；Claude Code 的 BYOK 实现仍在进行中
- 架构：用户自己开通 DeepSeek API，Key 存扩展 `chrome.storage.local`，扩展直接请求模型，不经过我们的服务器
- 内容：BYOK 首页说明、三步开通 API / 安装 / 填 Key、安装说明、无需 Key 的 Demo
- 本地服务：原 Fastify + APP_TOKEN 模式保留为开发者选项
- 目录：`design/ui-v3/`
- 压缩包：`design/shangtou-meowmeow-ui-v3.zip`
- 校验：`design/shangtou-meowmeow-ui-v3.sha256`
- 设计说明：`design/ui-v3/DESIGN.md`
- 交接单：`design/ui-v3/HANDOFF.md`

## ui-v2（2.2.0，2026-10-24，历史版本）

- 状态：保留作对比；公开叙事是“扩展 + 本机 Fastify + APP_TOKEN”，已被 BYOK 取代
- 目录：`design/ui-v2/`
- 压缩包：`design/shangtou-meowmeow-ui-v2.zip`

## ui-v1（2026-10-24，已废弃直连 API 方案）

- 状态：保留作对比；其“浏览器直连模型 Key”流程不再采用
- 目录：`design/ui-v1/`
- 压缩包：`design/shangtou-meowmeow-ui-v1.zip`

## 约定

- 冻结快照不直接改。
- 新设计在 `site/` 迭代，确认后另存新版本。
- UI 是独立静态站点，不改 `extension/`、`server/` 或现有测试。
- 公开版走 BYOK：网站不接收、不测试、不保存真实 API Key；输入只在扩展 popup。
- Key 存 `chrome.storage.local`，请求直接发往用户配置的模型服务；不承诺绝对安全。
- 原有 `serverUrl` + `appToken` 本地服务模式保留给开发者，不是公开用户的必经步骤。
- Claude Code 对接需先对齐 popup 字段名，再改网站。
