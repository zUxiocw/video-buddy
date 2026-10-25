# 喵喵陪你刷 · 作品提交 v1.0

> 抖音网页里的 AI 陪刷搭子。  
> **会接话，也会喊停；不撒娇，也不讨好。**

![一页作品介绍](one-pager/one-pager.png)

## 四项交付

| 提交项 | 位置 |
|---|---|
| README | 本文件；项目主页见 [`../README.md`](../README.md) |
| Demo | [`demo/index.html`](demo/index.html) · [`demo/demo.html`](demo/demo.html) · [`shangtou-meowmeow-demo.zip`](shangtou-meowmeow-demo.zip) |
| 仓库 | [github.com/zUxiocw/video-buddy](https://github.com/zUxiocw/video-buddy) · [`shangtou-meowmeow-repo.zip`](shangtou-meowmeow-repo.zip) |
| 一页介绍 | [`one-pager/one-pager.html`](one-pager/one-pager.html) · [PDF](one-pager/one-pager.pdf) · [PNG](one-pager/one-pager.png) |

提交总包：[`shangtou-meowmeow-submission.zip`](shangtou-meowmeow-submission.zip)

## 3 分钟验收

1. **先看一页**：打开 `one-pager/one-pager.pdf`。A4 单页，包含定位、性格、核心功能、实际页面、规则条和边界。
2. **再玩 Demo**：打开 `demo/index.html`，进入「在线试玩」。不需要扩展、不需要 API Key、不调用模型。
3. **看催促与关页**：在 Demo 里点「演示」看首次报额度；点「模拟沉默没说话」看催促、计数和停留计时暂停；向下滚到「到点关页」看关页与冷静期示意。
4. **再看仓库**：打开 [`../README.md`](../README.md) 或 GitHub，查看功能表、安装、BYOK、架构、测试与隐私边界。
5. **最后看源码**：扩展在 `extension/`，服务端在 `server/`，网页在 `site/`。

## 这是什么

一只住在抖音网页里的猫娘，不是视频总结工具，也不是客服。

- 你停在同一条视频上 10 秒，它读画面、文案和标签，主动接一句；
- 你接话，它用 9 种情绪回应；回复结束才换脸；
- 你刷过头，它先报当次总时长；到点先说一句，再关掉标签页；
- 沉默 1–10 分钟（默认 5）没主动说话，它每 5 秒催一次，直到你回它；催的时候，视频停留计时暂停；沉默只在视频播放且页面在前台时累计，暂停或切走不计入；
- 催满次数（默认 10 次，可调 3–60）还不回，它关掉标签页并进入冷静期，规定时间内打不开；
- 到点关视频始终开启、不可关闭；可调的是额度、冷静期、沉默开始时间和催满次数；
- 它不点赞、不评论、不关注、不刷数据，也不自动操作你的账号。

产品原则只有一句：**陪伴，不纵容。**

## 它不是撒娇讨好型

> “本猫娘不撒娇，也不讨好；有情绪，会表达，性子直。”

- 不会一口一个「主人」，也不会你说什么都顺着你；
- 有情绪：觉得视频离谱会嫌弃，觉得你刷过头会生气，觉得你难过会认真接住；
- 会表达：不绕弯子，不装客服，有自己的判断和态度；
- 性子直：像互相拆台的朋友，偶尔毒舌，但不攻击你这个人。

## Demo 说明

`demo/` 是 `site/` 的独立静态副本，打开即用。

- `demo/index.html` — 公开首页，包含性格介绍、双计时器、BYOK 与 FAQ
- `demo/demo.html` — 交互试玩：聊天、拖拽、9 情绪、首次报额度、1–10 分钟沉默催促、催满计数
- `demo/setup.html` — BYOK 三步说明，网站不接收、不保存真实 Key
- `demo/install.html` — 扩展安装说明，含 Chrome / Edge 设置位置图

直接打开 `demo.html`，或：

```powershell
cd demo
node serve.mjs
```

打开 `http://127.0.0.1:4173/demo.html`。

Demo 回复是本地写死的，不调用模型，不需要 Key。到点关页用桌面浏览器窗口示意，网页不会真的关闭你的标签页；真实关闭由扩展后台完成。1–10 分钟沉默、5 秒间隔与催满 10 次在 Demo 中做了加速。

## 仓库

- 远程仓库：`https://github.com/zUxiocw/video-buddy`
- 主分支：`master`
- 扩展：`extension/`（Chrome MV3）
- 服务端：`server/`（Node 22 + Fastify + TypeScript）
- 网页：`site/`（静态 HTML/CSS/JS）
- 截图：`docs/screenshots/`
- 一页介绍：`submission/one-pager/`
- 本地源码包：`shangtou-meowmeow-repo.zip`

```bash
git clone https://github.com/zUxiocw/video-buddy.git
cd video-buddy
```

### 跑起来

```powershell
# 扩展：加载 extension/ 到 chrome://extensions
cd server
npm install
npm test
npm run typecheck
npm run build
```

BYOK 模式不需要启动服务端；在扩展设置里选「直接用 API Key」，填自己的 DeepSeek Key 即可。本地 Fastify 模式见根 README 的「方式 B」。

## 一页介绍

- `one-pager/one-pager.html` — A4 单页源文件，浏览器直接打开
- `one-pager/one-pager.pdf` — 提交 / 打印版
- `one-pager/one-pager.png` — 预览图（2x）
- 版式：A4 纵向 210 × 297 mm，已按单页导出
- 版本：Submission v1.0

内容结构：作品名与定位、性格（不撒娇/有情绪/会表达/性子直）、3 个核心功能、3 张实际页面截图、使用流程、规则条、产品边界、BYOK 技术路径与提交链接。

## 边界

- 作品是桌面 Chrome / Edge 扩展，不是手机 App。
- 公开版走 BYOK：用户自己开通 DeepSeek API；网站不接收、不保存真实 Key。
- 本地 Fastify + `APP_TOKEN` 模式保留给开发者；模型 Key 在 `server/.env.local`。
- 不自动点赞、评论、关注或刷数据；不是抖音官方产品。
- 角色素材与 9 张情绪图仅用于本项目展示；对外分发或商用前请确认素材授权。
- 到点关页、沉默催促和键盘守卫的自动化 / headless 验证已通过；真实抖音页面回归仍建议按根 README 的步骤过一遍。

## 当前验证

- 服务端测试：**304 项通过 / 22 个文件**
- `typecheck` / `build`：通过
- 扩展直连检查：**25/25**
- 部署检查：**11/11**
- 一页介绍：**A4 单页**
- 截图与 Demo：桌面 / 手机无横向溢出

## 文件清单

```text
submission/
├─ README.md                        本文件
├─ demo/                            独立静态 Demo
├─ one-pager/                       HTML / PDF / PNG
├─ shangtou-meowmeow-demo.zip       Demo 单包
├─ shangtou-meowmeow-repo.zip       源码仓库包
├─ shangtou-meowmeow-submission.zip 提交总包
└─ ...
```

---

作品提交 v1.0 · 2026-10-25  
[github.com/zUxiocw/video-buddy](https://github.com/zUxiocw/video-buddy)
