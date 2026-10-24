# 喵喵陪你刷 · 独立 Demo

这是作品提交用的静态 Demo，不需要安装扩展、不需要 API Key，也不会调用真实模型。

## 直接打开

打开 `demo.html`，或带聊天面板启动：

```text
demo.html?open=1
```

建议用本地静态服务器打开，避免 `file://` 对 localStorage 的限制：

```powershell
cd submission/demo
node serve.mjs
```

打开 `http://127.0.0.1:4173/demo.html`。

## 页面

- `demo.html` — 交互试玩：手机框聊天 / 拖拽 / 9 情绪；首次报额度、1–10 分钟沉默催促、催满计数与关页示意
- `index.html` — 公开首页
- `setup.html` — BYOK 三步说明（网站不接收 Key）
- `install.html` — 扩展安装说明

## 边界

- 所有回复是本地写死的演示，不调用 DeepSeek。
- 到点关页是桌面浏览器窗口示意，网页不会真的关闭标签页；真实关闭由扩展后台完成。1–10 分钟沉默与 5 秒间隔在 Demo 中做了加速，催满 10 次只展示示意。
- 网站不接收、不保存 API Key；真实输入在扩展 popup。
