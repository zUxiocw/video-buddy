# UI v3 · BYOK 交接单

> 状态：**网页已按 BYOK 改完，等待验收；Claude Code 的 BYOK 实现仍在进行中。**
> 本仓库只改 `site/` 与 `design/`，不改 `extension/`、`server/`、manifest 或 content scripts。

## UI 假设的接口形状

UI 按现有 `extension/shared/core.js` 里的 BYOK 字段设计，期望 popup 最终提供：

- `mode: 'direct'`
- `apiKey`
- `apiBaseUrl`，默认 `https://api.deepseek.com`
- 本地服务模式继续使用 `mode: 'server'`、`serverUrl`、`appToken`

如果 Claude Code 最终字段名、默认值或文案不同，先同步本文件，再改网站；不要让网页写一套、扩展写另一套。

## 关键约束

- **网站不接收、不测试、不保存真实 Key**。`setup.html` 里的 Key 输入只是 popup 示意图，不是真表单。
- 真正的 Key 输入只在扩展 popup；普通网页无法写 `chrome.storage.local`，公开网页收 Key 也会制造钓鱼风险。
- Key 存 `chrome.storage.local`，不写进抖音页面；请求直接发往用户配置的模型服务。
- 不承诺“绝对安全”。要写清浏览器配置文件被读取、设备被控制、恶意扩展等风险。
- 插件不卖 Key、不代收、不共享额度；API 费用由用户和 DeepSeek 结算。
- 原有本地 Fastify 模式保留为开发者选项，不作为公开用户的必经步骤。
- 默认 `mode` 仍可能是 `server`（旧安装兼容）；UI 明确让用户在 popup 里选择「直接用 API Key」。

## 验收

- 首页出现 BYOK 说明、DeepSeek 外链、“Key 只在扩展本地”“不经过我们的服务器”。
- `setup.html` 三步为开通 API / 安装扩展 / 填 Key；没有真实 Key 输入框，没有 `APP_TOKEN` 表单。
- `install.html` 明确不需要 Node.js / 本地服务；BYOK 四步可照着走。
- Demo 明确不需要 API Key；正式版说明指向 BYOK。
- 全站不出现“模型 Key 留在服务端”“需要本机 Fastify 才能用”的旧公开叙事。
- 390px 移动端无横向溢出。
- 外链都有 `rel="noopener noreferrer"`。
- 本地 Fastify 说明只出现在开发者折叠区。

## 对接提醒

1. 先确认 popup 的字段名和模式名与 UI 文案一致。
2. 如果 popup 新增“测试连接”，确认它只请求用户配置的 Base URL，不把 Key 发给第三方诊断服务。
3. 如果 `apiBaseUrl` 允许自定义，确认强制 https，并在 UI 提示“陌生中转地址等于把 Key 交给对方”。
4. 如果默认模式改为 `direct`，需要同步说明旧安装的 `server` 配置如何迁移。
