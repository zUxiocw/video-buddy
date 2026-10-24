# 上头了喵喵 · UI v2 设计说明

- 版本：`2.0.0`
- 日期：`2026-10-24`
- 状态：**已按插件技术栈重做，等待用户验收**
- 替代：`design/ui-v1`（v1 的“浏览器直连模型 API”流程与现有 Fastify 架构冲突）
- 来源：`site/`
- 归档：`design/ui-v2/` + `design/shangtou-meowmeow-ui-v2.zip`
- 边界：独立静态 UI，不改 `extension/`、`server/` 或现有测试。

## 1. 这次修复了什么

v1 的配置页让用户填 `Base URL / API Key / model`，并声称扩展直接请求模型。  
现有插件实际是：

```text
Chrome MV3 扩展
  → 本机 Fastify（127.0.0.1:8787）
  → 服务端读取 server/.env.local 的模型 Key
  → DeepSeek / Mock
```

所以 v1 和插件是两套请求/配置模型。v2 不再假设“纯扩展 + 自带 API”，而是：

- 扩展只填 **服务地址 + APP_TOKEN + 可选设备 ID**
- 模型 Key 留在 **server/.env.local**
- 页面明确写出 **需要 Node 22 + Fastify 服务**
- “纯扩展 + 自带 API”只作为未来架构选项，不在 UI 里假装已支持

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 扩展 | Chrome Manifest V3 + 原生 JS |
| 服务 | Node 22 + Fastify + TypeScript |
| UI | 原生 HTML / CSS / JS，无 React / Next / Vite |
| 预览 | `site/serve.mjs`，仅静态开发服务器，不参与正式运行 |
| 配置 | `serverUrl` + `appToken`，与 `extension/popup` 一致 |
| 模型 | 服务端 `.env.local`，默认 DeepSeek，保留 Mock |

## 3. 页面

| 页面 | 文件 | 目标 |
|---|---|---|
| 首页 | `index.html` | 定位、9 情绪、本地服务、隐私、FAQ |
| 交互 Demo | `demo.html` | 假抖音页面、悬浮球、聊天、换视频、情绪切换 |
| 连接服务 | `setup.html` | 启动 Fastify / 调教性格 / 安装扩展 |
| 安装说明 | `install.html` | 扩展 + 本地服务的四步安装 |

快捷状态：

- `demo.html?open=1` 直接打开聊天面板
- `setup.html?step=2` 直接看性格设置
- `setup.html?step=3` 直接看安装步骤

## 4. 设计语言

沿用 v1 的视觉资产，不改角色：

- 奶油 `#f7f1e8` + 深紫 `#17131f` + 薰衣草 `#7c5cff` + 粉 `#ffd9e4`
- 9 张情绪图直接复用 `extension/assets/emotions/`
- 大标题 900 字重、负字距；正文系统中文 sans
- 卡片圆角 18–38px；按钮胶囊形，最小高度 46px

新增的“本地服务”组件：

- 深色命令卡：启动命令、`.env.local` 变量、复制按钮
- 三步服务说明：Node 22+ → `.env.local` → `npm.cmd run dev`
- 配置预览：服务地址 / 访问令牌 / 模型 Key / 请求方式

## 5. 页面文案边界

- 不再出现“自带 API Key”“不需要服务器”“浏览器直连模型”这类与现有架构冲突的承诺。
- 可以出现“纯扩展 + 自带 API”，但必须标明是未来架构决策，当前未实现。
- 下载按钮不指向未完成安装包。
- Demo 回复保持本地写死，不调用真实模型。

## 6. 可访问性

沿用 v1 并保持：

- skip link、`main` landmark、`focus-visible`
- 表单 label、`aria-live` 状态
- 关闭聊天面板时 `inert` + `aria-hidden`
- 390px 移动视口验证
- `prefers-reduced-motion`

## 7. 与 v1 的差异

| 项目 | v1 | v2 |
|---|---|---|
| 配置字段 | Base URL / API Key / model | 服务地址 / APP_TOKEN / 设备 ID |
| 模型 Key | 浏览器存储 | `server/.env.local` |
| 请求路径 | 扩展直连模型 | 扩展 → 本机 Fastify → 模型 |
| 安装 | 声称不需要服务器 | 明确需要本地 Fastify |
| 下载说明 | 等“自带 API Key”完成 | 等扩展 + 服务端打包 |
| 技术栈 | 新造一套前端叙事 | 与插件一致 |

## 8. 验收截图

- `screenshots/index.png`
- `screenshots/demo.png`
- `screenshots/setup.png`
- `screenshots/setup-install.png`
- `screenshots/install.png`
- `screenshots/setup-mobile.png`
