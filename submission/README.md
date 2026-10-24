# 作品提交包 · 上头了喵喵

> 抖音网页里的 AI 陪刷搭子。  
> **会接话，也会喊停。**

![一页作品介绍](one-pager/one-pager.png)

## 四项交付

| 提交项 | 位置 |
|---|---|
| README | [../README.md](../README.md) |
| 仓库 | [github.com/zUxiocw/video-buddy](https://github.com/zUxiocw/video-buddy) |
| Demo | [demo/demo.html](demo/demo.html) |
| 一页作品介绍 | [one-pager/one-pager.html](one-pager/one-pager.html) · [PDF](one-pager/one-pager.pdf) · [PNG](one-pager/one-pager.png) |

## 30 秒验收

1. 打开 `one-pager/one-pager.pdf`：一页图文介绍。
2. 打开 `demo/demo.html`：不需要 API Key，直接试玩聊天、拖拽、9 情绪。
3. 向下滚动 Demo 到「桌面浏览器演示」：到点 → 5 秒 → 标签页消失 → 冷却再打开。
4. 打开 `../README.md` 或仓库：查看功能、架构、BYOK 与本地服务两种运行方式。

## 仓库信息

- 远程仓库：`https://github.com/zUxiocw/video-buddy`
- 主分支：`master`
- 扩展：`extension/`（Chrome MV3）
- 服务端：`server/`（Node 22 + Fastify + TypeScript）
- 网页：`site/`（静态 HTML/CSS/JS）
- 设计冻结版：`design/`

克隆：

```bash
git clone https://github.com/zUxiocw/video-buddy.git
cd video-buddy
```

## Demo 说明

`demo/` 是 `site/` 的独立静态副本，包含：

- `demo.html` — 交互试玩
- `index.html` — 首页
- `setup.html` — BYOK 三步说明
- `install.html` — 扩展安装说明
- `assets/` — 9 张情绪图与图标

直接打开 `demo.html`，或：

```powershell
cd demo
node serve.mjs
```

打开 `http://127.0.0.1:4173/demo.html`。

Demo 回复是本地写死的，不调用模型，不需要 Key。限时是桌面浏览器窗口示意，网页不会真的关闭标签页。

## 一页介绍说明

- HTML：`one-pager/one-pager.html`，A4 单页，浏览器直接打开。
- PDF：`one-pager/one-pager.pdf`，用于提交与打印。
- PNG：`one-pager/one-pager.png`，用于预览或插入其他材料。
- 版式：A4 纵向 210 × 297 mm；已按单页导出。

## 边界

- 作品是桌面 Chrome / Edge 扩展，不是手机 App。
- 公开版走 BYOK：用户自己开通 DeepSeek API；网站不接收、不保存真实 Key。
- 本地 Fastify + `APP_TOKEN` 模式保留给开发者。
- 不自动点赞、评论、关注或刷数据；不是抖音官方产品。
- 角色素材与 9 张情绪图仅用于本项目展示，对外商用/再分发前请确认授权。
