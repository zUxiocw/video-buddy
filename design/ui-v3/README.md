# 上头了喵喵 · 公开版 UI（BYOK · 自带 API）

这是公开下载方向的前端原型，对应插件的 BYOK（Bring Your Own Key）方向：

- Chrome Manifest V3 + 原生 JS
- 用户自己开通 DeepSeek API，用自己的 Key
- Key 存在扩展的 `chrome.storage.local`，不写进网页
- 请求从浏览器扩展直接发往模型服务，不经过我们的服务器
- 不需要 Node.js / Fastify；原有本地服务模式保留给开发者

## 页面

- `index.html` — 产品首页：定位、刷视频限时、9 种情绪、BYOK、隐私、FAQ
- `demo.html` — 交互 Demo：假抖音页面、可拖拽悬浮球、聊天面板、限时关页演示；不需要 Key
- `setup.html` — BYOK 三步：开通 API / 安装扩展 / 在扩展里填 Key
- `install.html` — 扩展加载、DeepSeek API 开通、Key 填写与常见卡点

## BYOK 流程

1. 用户到 DeepSeek 开放平台注册、充值、创建 API Key。
2. 下载并加载扩展。
3. 打开扩展设置，在「方式」里选择「直接用 API Key」，粘贴 Key，测试连接后保存。
4. 费用由用户和 DeepSeek 结算；插件不卖 Key、不代收、不共享额度。

## 本地预览

```powershell
cd D:\code\video-buddy\site
node serve.mjs
```

打开 `http://127.0.0.1:4173`。`serve.mjs` 只是静态预览，不参与正式运行。

方便检查特定状态：

- `demo.html?open=1` — 直接打开聊天面板
- `setup.html?step=2` — 直接看安装扩展
- `setup.html?step=3` — 直接看填 Key

## 技术栈边界

- `site/` 是独立静态目录，不引用 `extension/` 的运行时代码。
- 只复制了 9 张情绪图作为设计资产，原图未改。
- 不改 `extension/manifest.json`、content scripts、background、server 或现有测试。
- 网站不接收、不测试、不保存真实 API Key；真正的输入框只在扩展 popup。
- Key 在 `chrome.storage.local`，抖音页面脚本读不到；它不是加密保险箱，设备被读取时仍可能泄露。
- 原有 `serverUrl` + `APP_TOKEN` 本地 Fastify 模式仍保留给开发者，但不是公开用户的必选项。
- 截图会随请求发到用户配置的模型服务；关闭截图后只使用文案和标签。

## 说明

- Demo 回复是本地写死的，不调用模型，也不需要 Key。
- 下载按钮当前只打开说明弹窗，不发未完成的安装包。
