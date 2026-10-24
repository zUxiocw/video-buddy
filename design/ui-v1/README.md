# 喵喵陪你刷 · 公开版 UI 预览

这是公开下载方向的前端原型，不是最终扩展包，也不改动现有扩展。

## 页面

- `index.html` — 产品首页：定位、9 种情绪、API 接入、隐私、FAQ
- `demo.html` — 交互 Demo：假抖音页面、悬浮球、聊天面板、情绪切换
- `setup.html` — 三步配置：模型 / 性格 / 安装
- `install.html` — Chrome / Edge 安装说明与发布状态

## 本地预览

```powershell
cd D:\code\video-buddy\site
node serve.mjs
```

打开 `http://127.0.0.1:4173`。

方便检查特定状态：

- `http://127.0.0.1:4173/demo.html?open=1` — 直接打开聊天面板
- `http://127.0.0.1:4173/setup.html?step=2` — 直接看性格设置
- `http://127.0.0.1:4173/setup.html?step=3` — 直接看安装步骤

## 隔离原则

- `site/` 是独立静态目录，不引用 `extension/` 的运行时代码。
- 只复制了 9 张情绪图作为设计资产，原图未改。
- 不改 `extension/manifest.json`、content scripts、background、server 或现有测试。
- 后续正式接入 API 时，再单独改扩展；这份 UI 可以继续作为官网、配置向导和交互预览。

## 说明

- 所有 API Key 表单都是演示，不会发送密钥。
- Demo 回复是本地写死的，不调用模型。
- 正式扩展需要把当前的本地 Fastify 服务改成扩展内直接请求用户配置的 OpenAI-compatible API。
- 下载按钮当前只打开说明弹窗，不发未完成的安装包，避免用户装到一个还需要本地服务器的版本。
