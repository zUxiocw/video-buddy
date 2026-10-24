# 上头了喵喵 · 公开版 UI（v2 · 本地服务）

这是公开下载方向的前端原型，**与现有插件技术栈对齐**：

- Chrome Manifest V3 + 原生 JS
- Node 22 + Fastify + TypeScript
- 扩展只连本机 `127.0.0.1:8787`，模型 Key 留在 `server/.env.local`
- 不引入 React / Next / Vite，也不另起第二套后端

## 页面

- `index.html` — 产品首页：定位、9 种情绪、本地服务、隐私、FAQ
- `demo.html` — 交互 Demo：假抖音页面、悬浮球、聊天面板、情绪切换
- `setup.html` — 三步配置：启动服务 / 调教性格 / 安装扩展
- `install.html` — 扩展 + 本地服务的安装说明与发布状态

## 本地预览

```powershell
cd D:\code\video-buddy\site
node serve.mjs
```

打开 `http://127.0.0.1:4173`。`serve.mjs` 只是静态预览，不参与正式运行。

方便检查特定状态：

- `demo.html?open=1` — 直接打开聊天面板
- `setup.html?step=2` — 直接看性格设置
- `setup.html?step=3` — 直接看安装步骤

## 技术栈边界

- `site/` 是独立静态目录，不引用 `extension/` 的运行时代码。
- 只复制了 9 张情绪图作为设计资产，原图未改。
- 不改 `extension/manifest.json`、content scripts、background、server 或现有测试。
- 配置流程以现有 `serverUrl` + `appToken` 为准；不再写“浏览器直连模型 API”。
- 模型 Key 只在 `server/.env.local`；扩展不存模型 Key。
- 如果以后真的要做“纯扩展 + 自带 API”，那是另一项架构改造，需要单独确认，不能偷偷改这条链路。

## 说明

- 所有配置表单都是演示，不会发送令牌或请求服务。
- Demo 回复是本地写死的，不调用模型。
- 下载按钮当前只打开说明弹窗，不发未完成的安装包。
