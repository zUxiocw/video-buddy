# UI v3 · BYOK 交接单

> 状态：**网页已按 BYOK 改完，限时演示已移到桌面浏览器窗口；扩展侧已对齐，见下方「已确认的形状」。**
> 本仓库只改 `site/` 与 `design/`，不改 `extension/`、`server/`、manifest 或 content scripts。

## 已确认的形状（2026-10-24 由扩展侧确认）

popup 的字段与文案已经落地，网站文案按这一份写，不要再各写一套：

- `mode: 'direct'` / `'server'` — **全新安装默认 `'direct'`**，旧配置留在 `'server'`
- `apiKey`、`apiBaseUrl`（默认 `https://api.deepseek.com`，只收 https，loopback 例外）
- 本地服务模式：`serverUrl`、`appToken`，下拉里显示为「连自己的服务（需先启动）」
- **`proactive`**（复选框「停留后主动搭话」）— 默认勾选；关掉后不再主动开口，包括开页面的招呼；悬浮球和聊天照常
- **`captureEnabled`**（复选框「把画面截图一起发给模型（关掉只发文案和标签）」）— 默认勾选；关掉后请求体里没有 `images`
- **`enabled`**（「在抖音页面显示悬浮球」）、**`limitEnabled`**（「到点提醒并关闭网页」，默认未勾选）
- 「测试连接」在直连模式下会 `GET {apiBaseUrl}/models` 真的验证 Key（免费调用，不花 token）；失败分三类：Key 被拒 / 限流 / 连不上

如果 Claude Code 的字段名、默认值或文案再变，先同步本文件，再改网站；不要让网页写一套、扩展写另一套。

## 关键约束

- **网站不接收、不测试、不保存真实 Key**。`setup.html` 里的 Key 输入只是 popup 示意图，不是真表单。
- 真正的 Key 输入只在扩展 popup；普通网页无法写 `chrome.storage.local`，公开网页收 Key 也会制造钓鱼风险。
- Key 存 `chrome.storage.local`，不写进抖音页面；请求直接发往用户配置的模型服务。
- 不承诺“绝对安全”。要写清浏览器配置文件被读取、设备被控制、恶意扩展等风险。
- 插件不卖 Key、不代收、不共享额度；API 费用由用户和 DeepSeek 结算。
- 原有本地 Fastify 模式保留为开发者选项，不作为公开用户的必经步骤。
- 默认 `mode` 仍可能是 `server`（旧安装兼容）；UI 明确让用户在 popup 里选择「直接用 API Key」。
- 限时演示必须留在桌面浏览器窗口，不能塞回手机框。网页无法真实关闭标签页，文案必须写“示意”，真实关闭由扩展后台 `chrome.tabs.remove` 完成。

## 验收

- 首页出现 BYOK 说明、DeepSeek 外链、“Key 只在扩展本地”“不经过我们的服务器”。
- `setup.html` 三步为开通 API / 安装扩展 / 填 Key；没有真实 Key 输入框，没有 `APP_TOKEN` 表单。
- `install.html` 明确不需要 Node.js / 本地服务；BYOK 四步可照着走。
- Demo 明确不需要 API Key；正式版说明指向 BYOK。
- 全站不出现“模型 Key 留在服务端”“需要本机 Fastify 才能用”的旧公开叙事。
- 手机框内没有 `#phoneLimit` 或任何限时层；限时在独立桌面浏览器窗口演示。
- 桌面演示能显示“到点开口 → 5 秒 → 标签页消失 → 冷却再打开”，并明确不实际关闭标签页。
- 390px 移动端无横向溢出。
- 外链都有 `rel="noopener noreferrer"`。
- 本地 Fastify 说明只出现在开发者折叠区。

## 对接提醒

1. 先确认 popup 的字段名和模式名与 UI 文案一致。
2. 如果 popup 新增“测试连接”，确认它只请求用户配置的 Base URL，不把 Key 发给第三方诊断服务。**已确认**：`background.js` 的 `directPing()` 只 `GET settings.apiBaseUrl + '/models'`，没有第三方诊断服务。
3. 如果 `apiBaseUrl` 允许自定义，确认强制 https，并在 UI 提示“陌生中转地址等于把 Key 交给对方”。**已确认**：`normalizeApiBaseUrl()` 只收 https，非法值回落到官方地址；`install.html` 的 FAQ 写了中转地址的风险。
4. 如果默认模式改为 `direct`，需要同步说明旧安装的 `server` 配置如何迁移。**已确认**：`legacyMode()` 让没有 `mode` 键的旧配置留在 `server`，升级不会被改道；网站不需要额外写迁移说明，只需保留「方式」下拉的两种选择。
5. **下载按钮**：`site/app.js` 用 `HEAD site/download/shangtou-miaomiao-v<version>.zip` 判断安装包在不在，在就给下载、不在就退回说明弹窗。ZIP 是构建产物（被 `.gitignore` 的 `*.zip` 排除），部署时需要先跑 `node extension/tools/pack-extension.mjs --out site/download` 一起上传。
