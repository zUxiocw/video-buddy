# 上头了喵喵 · UI v3 设计说明（BYOK）

- 版本：`3.0.0`
- 日期：`2026-10-24`
- 状态：**BYOK 网页已改完，等待验收；Claude Code 的 BYOK 实现仍在进行中**
- 来源：`site/`
- 归档：`design/ui-v3/` + `design/shangtou-meowmeow-ui-v3.zip`
- 边界：独立静态 UI，不改 `extension/`、`server/` 或现有测试。

## 1. 为什么从 v2 升到 v3

v2 的公开叙事是“扩展 + 本机 Fastify + APP_TOKEN”，模型 Key 留在 `server/.env.local`。Claude Code 正在做的 BYOK 把公开路径改成：

```text
Chrome MV3 扩展
  → 用户在 DeepSeek 开放平台自己开通 API
  → Key 填进扩展设置（chrome.storage.local）
  → 扩展 service worker 直接请求 DeepSeek
  → 不经过我们的服务器
```

因此 v3 不再把“需要本机 Fastify”当作公开用户的必经步骤，而是把它降级为开发者模式。BYOK 是公开路径，本地服务模式仍保留。

## 2. 安全与产品边界

- 网站 **不接收、不测试、不保存真实 API Key**。真正的输入框只在扩展 popup。
- Key 存在 `chrome.storage.local`，不写进抖音页面；抖音页面脚本读不到。
- 请求直接发往用户配置的「API 地址」，默认 `https://api.deepseek.com`；不经过我们的后端。
- Key 不是加密保险箱：能读浏览器配置文件的人或高权限软件仍可能拿到；泄露后去平台吊销。
- 插件不卖 Key、不代收、不共享额度。API 费用由用户和 DeepSeek 结算。
- 原有 `serverUrl` + `APP_TOKEN` 本地 Fastify 模式保留给开发者、离线 Mock 和不想把 Key 放浏览器的场景。
- 默认 `mode` 可能是 `server`（兼容旧安装）；UI 明确让用户选择“直接用 API Key”，不假设升级后自动切换。

## 3. 页面

| 页面 | 文件 | BYOK 下的目标 |
|---|---|---|
| 首页 | `index.html` | 讲清楚 BYOK、自己的账号/额度、Key 只存扩展；9 情绪与限时保留 |
| 交互 Demo | `demo.html` | 无需 API Key 的本地演示；明确“正式版用你自己的 Key” |
| 开通 API | `setup.html` | 三步：开通 DeepSeek API / 安装扩展 / 在扩展里填 Key |
| 安装说明 | `install.html` | 四步安装；BYOK 为主，本地 Fastify 仅作开发者选项 |

快捷状态：

- `demo.html?open=1` 直接打开聊天面板
- `setup.html?step=2` 直接看安装扩展
- `setup.html?step=3` 直接看填 Key

## 4. 新增组件

### BYOK 三步

- 顶栏：`BYOK · 自带 API Key`，明确“不需要我们的账号 · 本页不收 Key”。
- 步骤条：`开通 API / 安装扩展 / 填 Key`。
- 第一步：DeepSeek 开放平台外链、注册/充值/创建 Key 的步骤、Key 等同余额的警告。
- 第二步：下载、解压、开发者模式加载；明确不需要 Node.js / Fastify。
- 第三步：扩展 popup 的静态示意（方式：直接用 API Key / API Key / API 地址 / 测试连接 / 保存）。
- 底部 `<details>`：开发者本地 Fastify 模式与启动命令。

### 安全文案

- 首页展示 `chrome.storage.local`、直连模型、没有我们的后端。
- 安装页把“Key 不是加密保险箱”写在安全边界里，避免过度承诺。
- 全站不写“绝对安全”“匿名”“免费”。

## 5. 文案边界

- 可以写：自己的账号、自己的额度、不经过我们的服务器、Key 只存扩展本地。
- 不可以写：我们托管 Key、我们代充、共享 Key、免费 API、绝对安全。
- 不把“直接用 API Key”写成“无需配置”；用户必须自己开通并充值。
- 不把本地 Fastify 模式从历史中抹掉，但也不把它当作公开用户必选项。
- Demo 不调用模型、不需要 Key，不能暗示 Demo 已经接入真实模型。

## 6. 可访问性与响应式

- 外链使用 `target="_blank" rel="noopener noreferrer"`。
- 步骤条保留 `aria-current="step"`；步骤面板 `hidden` 切换。
- BYOK popup 示意使用静态文本，不伪造可交互的 Key 输入框。
- 390px 下步骤、提示、popup 示意、预览卡均无横向溢出。
- 保留 skip link、focus-visible、44px 触控目标和 `prefers-reduced-motion`。

## 7. 与 v2 的差异

| 项目 | v2 | v3 |
|---|---|---|
| 公开路径 | 扩展 + 本机 Fastify | 扩展 + 用户自己的 DeepSeek Key |
| 模型 Key | `server/.env.local` | `chrome.storage.local` |
| 服务地址 | 必填 `serverUrl` | BYOK 下不需要；开发者模式才用 |
| APP_TOKEN | 必填 | BYOK 下不需要 |
| Node.js | 公开用户必装 | 开发者模式才需要 |
| 费用 | 用户自己跑服务 | 用户自己和 DeepSeek 结算 |
| 网站是否收 Key | 不收 | 不收；只展示扩展 popup 示意 |
| 本地服务 | 主路径 | 开发者选项 |

## 8. 验收截图

- `screenshots/index.png`
- `screenshots/index-byok.png`
- `screenshots/index-emotions.png`
- `screenshots/demo.png`
- `screenshots/demo-limit-warning.png`
- `screenshots/setup-byok.png`
- `screenshots/setup-byok-key.png`
- `screenshots/setup-byok-mobile.png`
- `screenshots/install.png`
- `screenshots/install-mobile.png`
