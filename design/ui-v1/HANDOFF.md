# UI v1 · Claude Code 对接交接单

> 状态：**等待用户明确同意后再开始 Claude Code 对接。**
> 未获同意前，不要改插件代码、不要改 `CLAUDE.md` 的对接章节、不要新增 Claude Code 命令。

## 先读

1. 项目根目录 `CLAUDE.md`
2. 本目录 `DESIGN.md`
3. `site/` 下的四个页面与 `styles.css` / `app.js`
4. 现有扩展的 `extension/manifest.json`、`content/buddy.js`、`shared/emotions.js`

## 不可破坏的边界

- `design/ui-v1/` 是冻结快照，不要直接修改。
- 视觉改动只在 `site/` 做；确认后另存 v2。
- 本 UI 不改 `extension/`、`server/`、`manifest.json`、content scripts、background、现有测试。
- 现有插件的聊天、9 情绪、键盘隔离、主动搭话、历史记录、限时功能不能被 UI 改动影响。
- 下载 CTA 不能指向未完成的包；正式包需要先完成扩展侧 API 接入。

## 若用户同意“UI 交接”方向

只做文档和命令层：

- 把 `design/ui-v1/DESIGN.md` 的关键约束写进项目文档
- 新增/更新 Claude Code 命令，让后续会话先读设计规范
- 不直接改业务代码

## 若用户同意“扩展 API 接入”方向

这是另一项工程，需单独确认：

- 在 `chrome.storage.local` 增加 `apiConfig`：provider / baseURL / key / model
- background service worker 直接请求 OpenAI-compatible API，去掉对本地 Fastify + `APP_TOKEN` 的依赖
- 保留现有聊天 SSE、9 情绪、键盘隔离、主动搭话、历史记录、限时逻辑
- 补齐错误提示：401 / 403 / 404 / 超时 / 限流 / 空 Key
- 打包 zip，再考虑 Chrome Web Store
- 改完至少跑现有服务端测试、扩展语法检查和 e2e

## 推荐交接顺序

1. 先让 Claude Code 只读 `DESIGN.md` + `CLAUDE.md` + `site/`，输出一份差异/风险清单。
2. 用户确认清单后，再决定是“只同步文档”还是“开始改扩展 API”。
3. 任何视觉调整先改 `site/`，不要改冻结快照。

## 当前验收

- UI 交互测试：Demo 聊天、情绪切换、换视频、下载弹窗、配置向导、保存配置、无运行时错误，全部通过。
- 桌面 1440px、移动 390px 截图已归档。
- 原服务端测试仍通过；本 UI 未改服务端。
