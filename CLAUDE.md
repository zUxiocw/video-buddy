# video-buddy · Claude Code 项目说明

> 最后更新：2026-10-25
> 项目：抖音网页悬浮球「喵喵陪你刷」聊天插件
> 技术栈：Chrome Manifest V3 + 原生 JS；Node 22 + Fastify + TypeScript；DeepSeek OpenAI-compatible
> 交接状态：功能可运行，自动化测试通过（294 个）+ 直连端到端 25 项（`tools/direct-check.mjs`，不需要 Key）；红点移除 / 广告识别 / 长视频复聊三项真实抖音页面回归已由用户确认（2026-10-24）。**到点关视频（§2.1.7）、沉默催促与催满关页（§2.1.11 / §2.1.12）、键盘守卫、BYOK 直连模式（§2.1.9）只做过自动化/headless 验证，真实抖音页面回归待做**——直连的真 Key 验证用户已在本机通过（2026-10-24，失败一次是 API 地址填错），见 §4.7.2。改动前先读本文件，改动后跑第 4.4 节验收。
> 给 Claude Code：先读第 2.2 节（表情链路）和第 6 节（对接/守则）；开始改代码前先执行 `/handoff-check`。

## 1. 项目结构

- `extension/`
  - `manifest.json` — MV3；**两条** content scripts 条目：`shared/keyboard-guard.js`（`document_start`，键盘隔离）在前，`shared/core.js` → `shared/emotions.js` → `content/buddy.js`（`document_idle`）在后。第 2 条内部顺序不可改
  - `content/buddy.js` — 悬浮球、停留计时、聊天面板、SSE 流、表情切换、到点关视频（`limiter`）
  - `shared/keyboard-guard.js` — `document_start` 安装 window 捕获阶段键盘守卫；面板输入框里的 Enter/Escape 通过 `window.__smKeyboardGuard.setHandlers()` 回调给 `buddy.js`
  - `shared/core.js` — 设置、请求体、SSE parser、历史记录、限时额度状态机
  - `shared/emotions.js` — 9 情绪、别名、关键词/语气识别、图标路径
  - `shared/persona.js` — **人设规则唯一副本**（`globalThis.SmPersona`）；服务端 `prompts/persona.ts` 只是薄封装
  - `shared/text-core.js` — **纯文本工具唯一副本**（`globalThis.SmText`）：`clampText` / `sanitizeUntrusted` / `dedupeStrings` / `normalizeForMatch` / `bigrams` / `overlapCount` / `seed`。`seed` 是 FNV-1a，替代服务端的 `node:crypto` 版本，service worker 里也能用
  - `shared/guards-core.js` — **喵后缀 / maomao 文风 / 广告台词 / 中性兜底 / 黑名单 / 广告判定 / analyze 收尾唯一副本**（`globalThis.SmGuards`）；依赖 `text-core.js` 先加载
  - `shared/voice-filter.js` — **流式过滤唯一副本**（`globalThis.SmVoiceFilter`），依赖 `guards-core.js` 先加载
  - `shared/zh-prompt.js` — **system prompt / 视频锚点 / 情绪底色 / 表情配额 / 角度去重 / BUCKET_HINT 唯一副本**（`globalThis.SmPrompt`），依赖 `text-core.js`
  - `background.js` — 唯一访问模型的 service worker（服务端或直连两种模式）；代理 SSE，转发 `done.emotion`。**开头 `importScripts()` 的 6 个文件不进 `manifest.json`**，打包时由 §4.5 的脚本从源码解析出来
  - `popup/` — 设置页（接入方式、服务地址/令牌或 API Key、停留/复聊间隔/气泡/图标时长等）
  - `assets/emotions/{id}-128.png` — 9 个运行时图标
  - `icons/icon{16,48,128}.png` — 工具栏图标，由 `assets/emotions/greet-128.png`（默认态立绘）缩放生成；换角色时同步重生成
  - `tools/e2e.mjs` — 扩展 e2e harness（可选）
  - `tools/direct-check.mjs` — **直连模式端到端检查**：headless Chrome + 本地假模型服务，不需要 API Key、不花 token，25 项断言，见 §4.7
  - `tools/pack-extension.mjs` — 公开分发打包脚本；**白名单**产出 ZIP，见 §4.5
- `server/`
  - `src/index.ts` — Fastify 启动
  - `src/routes/chat.ts` — `/v1/chat` SSE
  - `src/routes/analyze.ts` — `/v1/analyze`
  - `src/prompts/persona.ts` — 人设**薄封装**，实现是 `extension/shared/persona.js`
  - `src/prompts/zh.ts` — **薄封装**，实现在 `extension/shared/zh-prompt.js`。`SlangLexicon` 的 result 由 `formatSlangForPrompt(entry)` 传进去，`node:fs` 留在 `trends/`
  - `src/providers/` — `DeepSeekProvider` / `MockProvider`
  - `src/safety/guards.ts` — **薄封装**，实现在 `extension/shared/guards-core.js`
  - `src/safety/voiceFilter.ts` — **薄封装**，实现是 `extension/shared/voice-filter.js`
  - `src/lib/text.ts` — **薄封装**，实现在 `extension/shared/text-core.js`；只保留服务端独有的 `hashShort`（`node:crypto`）、`isAbortError`、`delay`
  - `src/lib/dataPath.ts` — 从 `import.meta.url` 逐级上溯定位 `server/data/*.json`（见 §4.6）
  - `test/` — Vitest
- `tools/`
  - `pack-site.mjs` — **网站发布目录打包**（白名单）→ `site-dist/`；`--zip` 同时产出 `site-dist.zip`，见 §4.8
  - `zip-writer.mjs` — **ZIP 写入唯一副本**（无依赖），`pack-extension.mjs` 与 `pack-site.mjs` 共用
  - `check-deploy.mjs` — **线上站点检查**：headless Chrome 打开真实 URL，11 项断言，不需要 Key，见 §4.8
- `site/` — 公开网页（4 页 + `app.js` / `styles.css` / 情绪图 / `download/*.zip`），`site/README.md` 是内部说明、不进发布目录
- `extension.pem`、`server/.env`、`server/.env.local` — 敏感文件，不要读、不要改、不要提交
- `.claude/commands/` — Claude Code 斜杠命令
- 备份：无（`.backup-*` 快照已于 2026-10-24 清理，见第 8 节）

## 2. 当前行为（不要改坏）

### 2.1 悬浮球与主动搭话

1. 同一视频停留 `dwellSeconds`（默认 10s，范围 10–120）后，content 调 `/v1/analyze`。
2. 请求体带 `dwellMs`、`caption`、`hashtags`、截图（可选）、`recentReactions`、`adLabel`、`repeat`、`videoBucket`。**`dwellMs` 只用于扩展端的读秒判断和日志，不写进 prompt**（见 2.1.5）。
3. 服务端返回 `reaction` / `mood` / `summary` / `keywords` / `risk` / `isAd`。
4. 扩展：
   - `state.lastAnalysis` 保存 summary / keywords / caption，供聊天锚点。
   - `onDwell()`：`data.isAd` 为真直接 `Emotions.get('angry')`；否则先 `Emotions.detect(stripMaoTail(reaction))`，没有结果再用 `Emotions.fromMood(mood)`，然后 `ui.setEmotion(..., { source: 'vibe' })`。
   - `ui.appendReaction()` 立即写入聊天记录（面板关着也写），`ui.showReaction()` 显示气泡。
   - 只有请求失败才 `backoff()`；成功的下一条视频不应被静音。
5. 气泡显示时长由 `bubbleSeconds` 控制（默认 20s，4–120）。
6. 图标**没有红点**。曾经在右上角加过未读红点，噪音大于信息，已彻底删除；不要再加回来。
7. **三个独立开关（都默认 `true`，缺失键也解析成 `true`，所以升级不改任何现有行为）**，因为网站对用户承诺了「可以单独关闭」：
   - `enabled` — 悬浮球与聊天面板的**总开关**。关掉后 `applySettings()` 把两个 host 都 `display:none`，并 `closePanel()`。
   - `proactive` — **主动开口**。只管「它自己先说话」：`onDwell()` 的反应和 `sayOpener()` 的开机招呼都归它管。关掉后悬浮球和聊天面板照常工作，用户发消息它照样回。
   - `captureEnabled` — 请求里带不带截图。关掉后 `capture` 直接是 `{ ok: false }`，`buildAnalyzeBody` 因此不发 `images` 键，模型只凭文案和标签接话。
   - **`proactive` 必须同时罩住 `sayOpener()`**：只在 `onDwell()` 里检查的话，关了「主动搭话」猫还是每次开页面都开口，网站那句承诺就是假的。限时关页的台词**不受它影响**——那是执行限制，不是搭话，属于到点关视频的硬边界。`extension-core.test.ts` 有一条读源码的测试守着这两点。
8. **凭证检查按模式走**：`core.js` 的 `modeConfigured(settings)` 是唯一的判断点——`direct` 看 `apiKey`，`server` 看 `appToken`。曾经的写法是在 `onDwell()` 里直接查 `appToken`，而 `direct` 模式根本不显示、也不会写这个字段，于是**每一台全新 BYOK 安装都不会主动开口**；老机器只是碰巧还留着早年 `server` 模式的 `appToken` 才显得正常。加第三种模式时改这一个函数即可，不要再在调用点各写一遍。

### 2.1.7 到点关视频（每日额度 + 关页）

1. **只统计真实观看**：`tracker.tick()` 里满足「页面可见 + 视频在播放（`readyState>=2` 且未暂停）」，才把这一段 `delta` 交给 `limiter.add()`。暂停、切后台、看别的站都不计时。
2. 累计口径是**本地自然日**：`smLimit` 里存 `{ day, usedMs, shutAt }`，跨天（`Buddy.dayKey()`）自动归零。不按自然日的话，长期累计早晚会把每个标签页都判超时。
3. **全浏览器只有一份总额，写入者只有 service worker**。content 只发 `sm:limitTick { deltaMs }`；`background.js` 的 `limitLedger` 是唯一权威，`creditWatch()` 从读到写全程同步（中间不能 `await`）。`chrome.storage` 没有 compare-and-swap，如果每个标签页各自 `get` + `set`，两个标签页会读到同一个基数、后写的把先写的时长抹掉。`core.js` 里对应的纯函数是 `limitCredit()` / `limitSnapshot()`。
4. 到点流程：`creditWatch()` 返回 `over` → 页面 `sayAndClose('over')`：切 `angry` 脸 → `appendNotice()` 写进聊天记录 → 气泡显示 → 等 `limitCloseSeconds`（默认 5s）→ `sm:closeTab` 让后台关页。额度溢出时**由后台自己盖 `shutAt`**（`limitCredit()` 内部），页面不必再写。
5. **关页只走后台** `chrome.tabs.remove`，用的是 `sender.tab.id`，页面传不进自己的 tabId；后台还校验 `sender.tab.url` 必须是抖音域名。`window.close()` 只作为兜底（普通标签页会被浏览器拒绝）。**不需要 `tabs` 权限**。
6. **冷却期**：关页瞬间就把 `shutAt` 写盘（不是等定时器触发——那时脚本可能已经随页面消失）。之后 `limitCooldownMinutes`（默认 10）内打开页面，`limiter.start()` 看到 `inCooldown` → 说一句 `back` 台词 → 再关一次。**冷却期内不计时**（`usedMs` 保持 0），而且**不会重新写 `shutAt`**——否则用户每探一次头冷却就往后推，10 分钟会变成无限期封锁。
   - 已经开着、从头看到尾的标签页拿到 `inCooldown` 时**必须说 `over` 台词**，不能说 `back`。用户并没有「重新点开」任何东西。
   - 「页面加载时额度就已经用完」这条路径不会 `creditWatch()`，所以它单独发 `sm:limitShutdown` → `stampShutdown()` 补盖 `shutAt`（幂等：已在冷却中则什么都不做）。少了这一步，之后每次打开都会说「时间到」而不是「还敢点开」。
7. 台词在 `core.js` 的 `LIMIT_LINES`（`over` / `back` 两组），本地模板，不依赖服务端：服务没起来也得能关页。全部以「喵」结尾，且不含任何时长数字（与 2.1.5 同一条硬规则）。
8. **招呼跟着限时走**：`limiter.start(sayOpener)` 只在允许观看时才回调 `sayOpener`。否则「你好呀」紧接「不给你刷了」再关页，像两个人格。
9. 设置项在 popup 的「到点关视频」：`limitEnabled` **固定 `true`，不可关闭** / `limitMinutes`（1–600，默认 30）/ `limitCooldownMinutes`（0–720，默认 10，0 = 只关一次）/ `limitCloseSeconds`（0–30，默认 5）。
10. `limitEnabled` 只保留历史/防御分支；`normalizeSettings()` 会把任何存储值（包括旧的 `false`）归一为 `true`。

### 2.1.8 设置迁移与全新安装默认值

1. **`limitEnabled` 固定 `true`**（产品边界：到点关视频始终开启、不可关闭）。`normalizeSettings` 不再保留 `false`；旧配置里的 `false` 会被归一为 `true`。数字参数（额度/冷静期/关页延迟）仍可调。
2. **旧配置迁移不再需要**：开关锁死后 `legacyLimitEnabled()` 已删除——一个永远返回 `true` 的迁移谓词只是噪音，留着会让下一个人以为还有第二条路径。显式 `false` 也归一为 `true`，这是有意的产品决定，不是遗漏。
3. `normalizeSettings()` 仍是 popup / background / content 的**唯一汇合点**；`legacyMode()` 只作为历史迁移辅助保留（`mode` 仍需要它），不要新增第二个设置归一入口。
4. `settingsVersion` 随设置在存储里落盘（当前 `SETTINGS_VERSION = 2`，缺失视为 1），给将来的形状迁移留挂点。**未来版本号要保留原值，不能用 `clampInt` 压回当前值**：降级运行时把「数据比代码新」这个信息抹掉，会造成二次迁移。
5. 改默认值必须同步测试：`limit.test.ts` 的共享 `settings` 常量显式写 `{ limitEnabled: true }`，因为它测的是限时器本身，不该依赖默认值。

### 2.1.6 截图：视频取帧 + 四格拼图

1. **优先从 `<video>` 取帧**（`buddy.js` 的 `frames` 模块）：`drawImage(video, canvas)` 缩到 260px 宽，滚动保留最近 8 帧。**不用 seek**，播放中采样，避免打断播放。
2. 采样间隔自适应：`frames.gapFor(goalMs)` = `goalMs / 8`（≥300ms），保证 8 帧覆盖整个读秒窗口，而不是只糊住最后几秒。
3. 取帧时立即 `getImageData(0,0,1,1)` 探测 canvas 污染。跨域媒体会在读像素时抛 `SecurityError`；一旦抛错就 `blocked = true` 永久停用取帧，**静默回退**整屏截图。
4. **四格拼图**（`frames.compose(4)`）用 `frameSamplePoints(4)` 选点（0.3/0.55/0.8/1，偏向前段），每格右上角画序号 1–4，仍合成**一张** JPEG，不改变请求结构、仍受 400KiB 限制。
5. 回退路径（`background.js` 的 `captureVisibleTab`）拍的是合成后的整屏，**必须先 `ui.setCaptureHidden(true)`** 再拍：否则悬浮球和上一条气泡会被拍进去，模型会从屏幕上读到自己上一句并复读。`nextPaint()` 有 200ms 兜底，因为后台标签页里 `requestAnimationFrame` 不触发。
6. 帧缓冲生命周期：video key 变化、没有可见视频时 `frames.reset()`；**复聊不重置**（仍是同一个视频）。
7. 时长只以分桶形式离开页面：`videoBucket(seconds)` → `short`(<30s) / `medium`(<180s) / `long`，`Infinity`（直播）和 `NaN` 返回空串。prompt 用 `BUCKET_HINT` 定性描述，**绝不传原始秒数**。
   - 空串时 `buildAnalyzeBody` **整个键不发**，不是发 `videoBucket: ''`：服务端 schema 是严格 enum，空串会被判 422「请求参数不合法」，直播/未加载的视频就永远收不到反应。
   - `dwellMs` 在客户端按 `MAX_DWELL_MS`（900_000，与服务端 schema 上限一致）钳制。复聊会累加（`dwellSeconds + n * repeatDwellSeconds`），默认设置第 16 句、最大设置第 3 句就会越界；不钳制等于长视频聊久了必然挂掉。
   - `server/test/frames.test.ts` 用**服务端导出的 `analyzeBodySchema`** 校验扩展产出的请求体（`analyzeBodySchema` 导出就是为了这个）。客户端和服务端分开改，形状对不上是静默全失效，必须由测试兜住。
8. prompt 里写明「图片可能是几帧拼在一起，左上角数字是先后顺序；不要推断没看到的动作或因果」，防止模型对静态帧做过度叙事。

### 2.1.6.1 400ms tick 只准做「不排版」的 DOM 读取

`tracker.tick()` 每 400ms 跑一次。往里面放一次 `getBoundingClientRect()` 或 `innerText`，就是每秒 2.5 次强制布局；放到 4 万节点的长 feed 上，实测单次 tick 47–56ms，**CPU 占用约 12%，就是用户感觉到的卡顿**。

1. `videoKey()` 只能调 `captionSignature(video)`：`textContent`（不排版）、只读播放中那条视频自己的节点。**不要**改回调 `readCaption()`（它要 `getBoundingClientRect()` 选最大可见的文案）或 `readScreenText()`（还带广告扫描）。
2. `captionSignature()` 必须**限定在播放中视频的 item 内**（`video.closest('article, li, [data-e2e="feed-item"], [data-e2e="video-item"]')`）。整页扫描不仅是成本问题——抖音会预载下一条的文案，整页读会让 key 在用户还看着这一条时变化，读秒被无故清零。
3. **找不到 item 包裹时要回退**到 `document` 里第一条 description。返回空串会让所有 `blob:` 视频共用同一个 key，整条 feed 被当成一个视频，复聊会一直触发。
4. 广告标签只在 `onDwell()` 里读一次。`AD_CHIP_SELECTOR`（带具体 data-e2e/class 契约）可以整页查；`AD_LOOSE_SELECTOR`（`[class*="tag" i] span`，泛化猜测）**必须**限定在 item 内，否则在长 feed 上是几千个节点。没有 item 可限定时只跑精确那一步，不回退整页（回退就把删掉的成本原样加回来了）。
5. 实测（38831 节点）：旧 tick 单次 47–56ms → 新 tick 0.001ms（6000 次调用合计 7.2ms）。改动前先量，别靠感觉判断「卡不卡」。

### 2.1.5 说话别提时长（避免重复感）

**硬规则：prompt 里不出现任何时长数字或「八秒/几秒/刷多久」这类措辞。**

1. `buildAnalyzeMessages()` 的 user 文本固定是「抖音视频，用户停在这一条上。」，**不插 `dwellMs`**。曾经的写法 `停留了 8000 毫秒` 让模型每轮都看到同一个数字，于是每句都回「八秒」——这是「对话略显重复」的最大来源，不是模型偏好。
2. 「看了更久」只由 `repeat: true` 表达（「这是同一个视频的第二眼」），不带数字。
3. 约束用**正向表述**：`不要提任何时长、秒数、分钟或「看了多久」，你并不知道用户看了多久`。旧规则写成「不要每轮提『八秒/刷视频/上瘾』」，等于每轮把目标词再喂给模型一次；不要再改回否定式词表。
4. `MockProvider` 的 maomao 池不得出现时长词（test/dwellTalk.test.ts 有守卫）。
5. **角度去重**：`zh.ts` 的 `usedAngles(recent)` 检测最近回复是否用过「停留时长 / 评论区 / 拍摄意图」，命中才追加一句 `最近这几句已经用过这些角度：…，这一轮换一个方向起手`。只在真的用过时出现，不常驻 prompt。
6. 有意**不做**确定性过滤（删掉含时长的分句）：会在 `这猫看八秒，你比它还有耐心` 这类句子上留下断句残骸，代价大于收益。约束靠 prompt + 测试守。
7. 历史反应会经 `appendReaction()` 进入聊天上下文，所以一旦出现时长句会自我强化；改这里时要注意 `state.messages` 里的旧记录。

### 2.1.3 长视频复聊（同一视频多次开口）

1. 第一次停留 `dwellSeconds` 开口；之后同一个视频每隔 `repeatDwellSeconds`（默认 60s，区间 0 或 20–600，0 = 不重复，见 §4.2.1）再说一句。
2. 读秒逻辑收口在 `core.js` 的 `dwellGoalMs(settings, firedCount)`：`firedCount === 0` 用 `dwellSeconds`，否则用 `repeatDwellSeconds`；返回 0 表示不再重复。
3. `tracker` 用 `firedCount`（按 video key）记**本次观看**已开口次数；每次开口后 `accumulated` 归零，下一轮按复聊间隔重新读秒。
4. **刷走再刷回来必须重新读秒**：video key 变化或没有可见视频时 `delete firedCount[旧 key]`，回到该视频时 `firedCount` 从 0 开始，等于第一次刷到。
5. `settingsChanged()` 只在 `dwellSeconds` / `repeatDwellSeconds` 实际变化时清空计数；改悬浮球大小、气泡时长不重启读秒。
6. 复聊请求带 `repeat: true`，`dwellMs` 上报累计观看时长，prompt 追加「这是同一个视频的第二眼」；聊天记录用「视频 N · 接着说」标注，**不增加** `videoCount`。

### 2.1.4 广告识别

1. 客户端 `buddy.js` 的 `readAdLabel()` 只认**独立短标签**的完整匹配：`AD_LABEL_TEXT = /^(广告|赞助|推广|品牌广告|商业推广|广告创意)$/`，且元素必须可见。文案里出现「广告」二字不算，避免误判「吐槽广告太多」这类视频。
2. 命中后 `buildAnalyzeBody` 带 `adLabel: true`；`/v1/analyze` 把它作为 `confirmed` 传给 `finalizeAnalyzeResult` 第 5 个参数。
3. 服务端 `isAdvertisement(result, confirmed)`：`confirmed` 直接为真；否则要求模型 `isAd === true` **且** summary/keywords/reaction 里有 `AD_MARKERS`（广告/赞助/小黄车/下单立减/带货等）。两个独立信号一致才判定，防模型幻觉。
4. 判定为广告：`reaction` 换成 `adReaction(tone)` 固定文案（每条都含「过分」/「气人」，供客户端识别），`memeUsed` 置空，`isAd` 回填到响应；置信度兜底被跳过（「这是广告」不是猜测）。
5. 客户端只要 `data.isAd` 就切 `angry`，不依赖正文识别。
6. 识别顺序：先判广告，再判 `blocked`。`blocked` 的结果 `isAd` 保留但 `reaction` 仍为空。

### 2.1.9 两种接入方式（server / direct）

1. `settings.mode` 只有 `'server'` 和 `'direct'` 两个值。**全新安装默认 `'direct'`**（公开版就是 BYOK，陌生人没有本地服务可指）；**旧配置必须留在 `'server'`**，见下条。
   - 判断在 `legacyMode()`：**有别的键但没有 `mode`** → 旧配置，`'server'`；**空对象** → 全新安装，用 `DEFAULTS.mode`；显式写入的 `'server'` / `'direct'` 永远优先。
   - 少了这条，升级用户会被静默改道到他没有 Key 的通道，猫直接哑掉。
   - 无法识别的值（`'DIRECT'` / `'byok'`）**不算旧配置**（键存在），按默认值处理，与 `enabled` 等字段一致。
2. `background.js` 是唯一出口，两条路径在 `analyze()` 和 `streamChat()` 开头分叉：
   - `server`：POST 到 `settings.serverUrl`，带 `appToken`。
   - `direct`：POST 到 `settings.apiBaseUrl` + `/chat/completions`，带用户自己的 `Authorization: Bearer`。
3. **两条路径必须喂给模型同样的东西**（`server/test/direct-parity.test.ts` 守着）：都调 `SmPrompt.buildAnalyzeMessages` / `buildChatMessages`，都跑 `SmGuards.finalizeAnalyzeResult`、`SmVoiceFilter.createMaomaoStreamFilter`、`SmPrompt.pickChatEmotion`，采样参数也一致（analyze `temperature 0.7` / `max_tokens 700` / `json_object` / `thinking.disabled`，chat `temperature 0.92` / `max_tokens 220` / 流式）。规则抄第二份就等于埋下「换个模式说话就变了」的坑。
4. **Key 只存 `chrome.storage.local`**，不写进代码、日志、URL。content script 读得到，页面脚本读不到（隔离世界）。
5. **权限按需申请，且必须由 popup 自己发起**：`manifest.json` 只声明 `optional_host_permissions: ["https://*/*"]`，装的时候不授予任何模型域名。`popup.js` 在提交处理里**同步**调 `chrome.permissions.request()`，收窄到配置的那一个 origin。
   - **不能绕经 service worker**：用户手势过不了 `sendMessage` 那一跳。曾经的写法是 popup 发 `sm:requestOrigin` 给 background 再请求，实测每次都返回「This function must be called during a user gesture」——弹窗永远出不来。`direct-check.mjs` 有一条断言守着请求方是 popup。
   - `await` 一下也会丢手势，Chrome 直接拒绝弹窗。
   - 不要把模型域名加进 `host_permissions`：那是安装即授予，违背「不多要权限」。
6. `normalizeApiBaseUrl()` 只接受 `https://`；非法值静默回落到 `https://api.deepseek.com`，避免把 Key 明文发到 `http://` 上。**唯一例外是 loopback**（`http://127.0.0.1` / `http://localhost`），见 §4.7.1。
7. **「测试连接」在直连模式下真的会连**：`popup.js` 的 `checkDirect()` 先查 origin 权限（没授权时提示「保存时会请求权限」，因为请求权限必须由提交按钮那次真实手势发起），然后 `sm:ping` → `background.js` 的 `directPing()` 发 `GET {apiBaseUrl}/models`。这是 OpenAI 兼容接口里的免费调用：能验证 Key 有效，又不消耗任何 token。
   - 旧实现只查本地状态（Key 非空、origin 已授权），**填了错 Key 也会报「已就绪」**——而这正是这个按钮唯一要抓的东西。`direct-check.mjs` 有 4 条断言，其中一条把 `directPing` 换成本地检查就会红。
   - 失败信息复用 `directFailure()`：401/403 → 「模型拒绝了访问令牌」，429 → 限流，5xx → 服务不可用。网站 `install.html` 的 FAQ 就按这三类写给用户。
   - 为什么先查权限：没权限时请求表现为网络错误，会被误读成「Key 不对」。
8. 错误映射沿用服务端那套：401/403 → `UPSTREAM_AUTH`，400/404 → `MODEL_UNAVAILABLE`，其余 → `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT`。
9. **直连没有热点/俚语注入**，`trendCandidates` / `slangCandidates` 恒为空，prompt 里显示「（无）」。这需要 `node:fs` 读词库 + 实时抓热榜，service worker 做不了，是**有意的能力取舍**，不是 bug。给直连补词库会引入第二种数据源，两份词库迟早不同步。

### 2.1.10 2026-10-25 协作改动：到点关视频默认开 + 沉默催促

本轮两个 Agent 在同一个仓库改，先按下面的文件所有权分工，避免互相覆盖：

- **Claude Code 负责**：`extension/shared/core.js`（计时器常量/纯函数/本地台词）、`extension/content/buddy.js`（计时器接入、暂停、提醒）、`extension/background.js`（只有必须时）、`server/test/*`（新增行为测试）。**`limitEnabled` 固定 `true`、沉默开始 1–10 分钟可调、popup 文案已由另一 Agent 先改好，不要回退**；改 `buddy.js` 时只动计时/聊天流程，不要重排 UI 结构。
- **另一 Agent 负责**：`site/`、`submission/demo/`、`README.md`、`submission/one-pager/` 的文案与功能展示（以及品牌改名）。Claude Code 不要改这些文件，避免网页文案与实现两边同时变。
- **共同底线**：不改 `manifest.json` 权限，不加新权限，不破坏 server / direct 两条链路，不改变 9 情绪链路和原有已确认的开关行为。

**当前状态（2026-10-25）**：品牌名、`limitEnabled` 固定开启、popup 文案、网页/README/一页介绍/截图已完成；到点关视频不可关闭，沉默开始 1–10 分钟可调，催满次数 3–60 可调。`nudge.test.ts` 40 项、服务端共 294 项测试与 `typecheck` / `build` 通过。接完代码后仍需真实抖音页面回归。

功能契约：

1. **到点关视频不可关闭**：`limitEnabled` 固定 `true`；显式保存的 `false` 也会被 `normalizeSettings` 归一为 `true`。popup 的 checkbox 只读展示「始终开启，不可关闭」，每日时长/冷静期/关页延迟仍可调。
2. **首次报总时长**：到点关视频始终开启，在本会话第一次用户对话、以及第一次「停留 10 秒」触发的反应处，各提醒一次当次 `limitMinutes`。提醒是本地 `appendNotice` 级别的系统话术，不调用模型、不消耗 Key；同一会话只提醒一次。提醒不能重置停留累计、不能触发 `onDwell()` 或改动额度。
3. **沉默催促**：记录用户最后一次**主动发消息**的时间（opener、主动搭话、限时提醒都不算）。沉默 `nudgeAfterMinutes`（1–10，默认 5）后开始每 5 秒（固定）说一句催促，直到用户主动发消息为止；不提供修改 5 秒间隔的设置项。催促台词用本地模板，不调用模型；要遵守 `enabled` / `proactive` 两个既有开关，不能绕过它们。
4. **催促期间暂停停留计时**：催促的 5 秒计时器运行期间，`tracker` 不累加本视频停留时长，`limiter.add()` 也不计每日额度；累计值冻结而不是清零。用户主动发消息后立刻恢复，从冻结值继续，不吐掉已经看了的时间，也不因催促触发新的 `onDwell()`。
5. **线程安全**：催促定时器与关页定时器互斥。`sayAndClose()` / 页面隐藏 / 新会话 / 关闭面板时要清掉催促定时器，不能出现关页后继续弹话、或两条催促重叠。所有台词以「喵」结尾，符合现有文风。
6. **测试**：新增/更新测试要覆盖默认值、提醒只出现一次、1–10 分钟触发、5 秒间隔、用户回话停止、暂停期间不计停留/额度、关闭 `proactive` 不催。不要只测纯函数，至少用 fake timer 跑一遍 `buddy.js` 的状态转换。

### 2.1.11 首次报额度 + 1–10 分钟沉默催促（2026-10-25）

1. **首次报额度**：到点关视频始终开启，本会话第一次开口会先用 `appendNotice()` 说一句「今天设的是 N 分钟」。
   - 两个入口都算「第一次开口」：`onDwell()`（停留触发的反应）与 `sendMessage()`（用户自己发的第一句），谁先到谁报，`state.budgetAnnounced` 保证**只报一次**。`newSession()` 把它清回 `false`——新对话该重新说一遍。
   - **不受 `proactive` 管**：这是限时器在解释一条已经在生效的规则，和关页台词同类。关掉「主动搭话」不能让标签页在毫无说明的情况下被关掉。
   - 在发请求**之前**说，因为这个数字是用户自己的设置，不该等一次可能失败或很慢的模型调用。
   - 台词在 `core.js` 的 `BUDGET_LINES`（5 条，含 `{minutes}` 占位符，全部以「喵」结尾）。这是**唯一**允许出现时长的本地台词：它读回的是用户自己设的额度，不是 CLAUDE.md §2.1.5 禁止模型谈论的观看时长。
2. **沉默催促**：`nudgeAfterMinutes`（1–10，默认 5）没有**主动发消息**，就每 5 秒（`NUDGE_GAP_MS`，固定）说一句，直到用户发消息为止。开始分钟数是设置项，5 秒间隔不是。
   - **只有 `sendMessage()` 算「主动」**：开机招呼、视频反应、额度提醒、催促本身都不能重置这个时钟，否则猫一直给自己续命、永远催不出来。
   - **状态机在 `core.js`，不在 `buddy.js`**：`Buddy.createNudgeMachine({ now, enabled, proactive, visible, afterMs, cap, onSpeak, onStop, onExhausted })`。页面只提供时钟、开关的读取函数和 DOM 回调。这样测试能用假时钟驱动**浏览器里真正跑的那份代码**，而不是一份重新实现的版本（CLAUDE.md §2.1.10 第 6 条要求）。
   - **不额外开定时器**：`tracker.tick()`（每 400ms）调 `nudge.tick()`，所以最多晚一个 tick，而且后台标签页不会留一个对着空房间说话的 timer。
   - **任一开关关掉就整个结束这次运行**（不是挂起）：`enabled` / `proactive` / 页面不可见三者任一为假都返回 inactive。挂起会让后台待久了攒一批台词，回来看的那一刻一次性倒出来。
   - **催促期间冻结停留计时与每日额度**：`tracker.tick()` 里 `if (!playing || delta <= 0 || nudge.isActive())` 一个 early return 同时挡住 `limiter.add()` 和 `accumulated +=`。催的时候还在给视频计时，等于一边骂一边算你上头，而且进度环会声称它在量注意力。**冻结不是清零**：用户回来接着看，从原来的进度继续。
   - `sayAndClose()` / 页面隐藏 / `newSession()` 都清掉运行状态；关页之后不能再冒出一句催促。
   - 台词在 `core.js` 的 `NUDGE_LINES`（8 条，全部以「喵」结尾，不含任何时长数字）。

### 2.1.12 催满次数关页（2026-10-25）

1. **设置**：`settings.nudgeLimitCount`，默认 `10`，范围 `3–60`（`NUDGE_LIMIT_MIN` / `NUDGE_LIMIT_MAX`），在 popup 的「沉默催促」区块里调。下限 3 留出回答时间，上限 60 约等于 5 分钟催促。
2. **计数口径**：计数在 `createNudgeMachine` 内部（`spoken` / `exhausted`），只数这次沉默 streak 里的催促台词；用户主动发消息（`userSpoke()`）或新会话（`restart()`）清零。正常聊天、视频反应、额度提醒都不计入；`stop()` 不清零，隐藏标签页不算回答。
3. **触发**：`tick()` 先 `spoken += 1`，读 `cap()`；达到上限时本拍不说普通催促，置 `exhausted`、保持 `active`，同步调 `onExhausted()`。页面把它接到 `limiter.closeForNudge()`；关页期间 `tick()` 继续冻结停留/额度，避免倒计时里再弹视频反应。
4. **关页**：`limiter.closeForNudge()` → `sayAndClose('nag')`：选 `LIMIT_LINES.nag` 收尾台词（含 `{count}`，替换成当前设置），写入聊天记录，显示气泡，然后走 `sm:limitShutdown`（带 `reason: 'nag'`）+ `sm:closeTab`。背景用 `limitAfterNag()` 保留已用额度再写 `shutAt`，所以冷静期结束不会白送一份新额度；冷静期沿用 `limitCooldownMinutes`（默认 10 分钟，0 = 不锁），重开时由 `limitSnapshot().inCooldown` 再关一次。
5. **开关边界**：`cap()` 始终返回 `settings.nudgeLimitCount`（到点关视频固定开启）；`proactive` 关闭时既不催也不关。`sayAndClose` / 页面隐藏 / 新会话都会清掉催促运行状态；`sayAndClose` 的台词标 `scripted`，不进入模型历史。
6. **台词**：`LIMIT_LINES.nag` 全部带 `{count}` 占位、以「喵」结尾、不提时长；替换后的台词仍参与 `recentLines` 去重。
7. **关页失败必须解冻**：`sayAndClose` 的定时器里，后台拒绝关页且 `window.close()` 也不生效时（普通标签页会被浏览器拒绝），调 `nudge.release()` 把 `exhausted` 和冻结一起撤掉，并重开沉默窗口。少了这一步，一次关不掉的标签页会留下**永久冻结的进度环和哑掉的猫**——比少关一次页严重得多。`release()` 只在 `exhausted` 时生效，正常催促期间调用是 no-op。
8. **测试**：`nudge.test.ts` 覆盖默认值/范围/`{count}` 占位/达到上限只触发一次/冻结状态/隐藏不重置/关页失败解冻；`limit.test.ts` 覆盖催满关页保留已用额度与 `background.js` 的 `reason` 分支。真实 DOM 关页仍建议抖音页面回归。

### 2.2 聊天与表情链路（重点）

**硬规则：用户发消息不切表情；只有 AI 完整回复结束后才切。**

1. `sendMessage()`：清洗文本、`pushMessage('user')`、`startStream(text)`。**不得**调用 `Emotions.detect` 或 `ui.setEmotion`。
2. `startStream()`：构造 history / payload，创建空 assistant 消息，建立 `sm-net` port，接收 `delta` / `error` / `done`。
3. 服务端 `/v1/chat`：
   - `pickChatEmotion(input)` 计算本轮提示，只在 `tone === 'maomao'` 时返回 9 个 id 之一或 `null`。
   - SSE `done` 帧：`{ finishReason: 'stop', emotion?: 'annoyed' | ... }`。
4. `background.js`：解析 `done` 里的 `emotion` 字符串，转发 `{ type: 'done', emotion }`。
5. `content/buddy.js`：
   - `done` 处理：`finishStream(reply, message.emotion)`。
   - `finishStream()`：先 `Emotions.detect(reply.content)`；没有结果且 `serverEmotion` 存在，才 `Emotions.get(serverEmotion)`；最后 `ui.setEmotion(vibe.id, { force: true, source: 'assistant' })`。
   - 同一个 `vibe.id` 还要交给 `setMessageEmotion(reply, id)`，让这条气泡的头像和悬浮球一致。
   - 优先级：**助手正文明确情绪 > 服务端情绪底色 > 不切换**。
6. 面板打开时图标计时器只重新计时，不回默认态；关闭面板不强制回 `greet`，到期才回。默认态是 `greet`。
7. 切换动画约 110ms 淡出淡入；最短 600ms 防抖；保持时长由 `emotionHoldSeconds` 控制（默认 6s，0 = 保持到下次变化）。

### 2.2.2 对话气泡头像

**硬规则：面板里每条 assistant 消息左侧都有一个 36px 圆形头像，用的是这条消息自己那个表情的立绘。**

1. 结构：`.msg.a` 是 flex 行（`max-width:96%; padding:0; background:transparent`），里面是 `.msgava` 头像 + `.col` 气泡（气泡底色、圆角、padding 都移到 `.col` 上）。用户消息仍是单层 `.msg.u`，没有头像。行宽为什么比 `.msg` 的 82% 还宽：头像和间距要占掉 36+8px，不加这一点，气泡在同字数下会比用户消息还窄。
2. 表情来源按顺序取：消息自带的 `message.emotion` → 没有就 `Emotions.detect(stripMaoTail(content))` 推一个。老会话存档里没有 `emotion` 字段，靠第二条兜底；推导是确定性的，重绘面板不会闪。
3. 写入 `emotion` 的位置：`appendReaction()`（用 `onDwell` 算出的 `vibe.id`，广告就是 `angry`）、`appendOpening()` 与两处 seed 引导语（固定 `greet`）、`startStream()`（先借 `state.emotion` 占位，避免空头像）、`finishStream()`（`setMessageEmotion()` 换成识别结果）。
4. **不能只靠文字反推**：`isAd` 强切 `angry`、`fromMood` 映射这些路径文字里不一定有情绪词，所以 `onDwell` 必须把 `vibe.id` 传给 `appendReaction()`。
5. 落盘：`core.js` 的 `normalizeMessage()` 保留 `emotion`，但只认 `EMOTION_IDS` 里的 id，未知值直接丢弃（避免改名后留下死引用），且只对 `assistant` 生效。`currentSession()` / `loadSession()` 都要带上它。
6. 流式回复的插入符在 `.col` 上（`.msg.a.caret .col:after`），不是整行 `:after`；写在行上会跑到气泡右边的空隙里。

### 2.1.1 「喵」后缀（任务约束）

**硬规则：所有开口都带「喵」后缀，但它不是情绪信号，不得影响任何识别/判断。**

1. 服务端统一收口，客户端不拼接：
   - `guards.ts` 的 `withMaoSuffix(text)`：纯追加，句尾标点保持在「喵」之后（`真的假的？` → `真的假的喵？`）；已有「喵」去重；纯标点回复（`？`）不加。
   - `/v1/analyze` 的 `finalizeAnalyzeResult()`：传到 `reaction`（仅 `tone === 'maomao'`）；`blocked` 仍为空。
   - `/v1/chat` 的 `createMaomaoStreamFilter().flush()`：只在整段回复最后一片追加一次。
   - `NEUTRAL_BY_TONE.maomao` 自带「喵」，避免兜底文案被二次拼接。
2. **客户端必须在识别前剥掉**：`buddy.js` 的 `stripMaoTail()` 用于 `finishStream()` 与 `onDwell()` 的 `Emotions.detect()`。原因：`踩了就这$` 这类规则锚定句尾，带「喵」会让 `就这喵` 识别失败（实测：raw=null，剥离后=annoyed）。
3. 模型侧禁止自写「喵」：`persona.ts` 与 `zh.ts` 的 prompt 都写了「句尾的喵由系统统一补」。否则会出「喵喵」或句中「喵」。
4. `flush()` 边界：若尾部字符被过滤规则删空（如 `可爱~~~!!`），用 `emitted` 记录已发送正文，单独补一个「喵」，不能丢。整段全是过滤字符时返回空。

### 2.1.2 开机招呼（首句）

1. 页面加载后 `sayOpener()` 说一句招呼/调侃，**本地模板池**产生，不请求服务端（服务没启动也能说）。
2. 模板在 `core.js` 的 `OPENERS`（10 条，全部以「喵」结尾）；`pickOpener(recent)` 避开本次已说过的，用完再回退全部。
3. 表情固定 `greet`，直接 `setEmotion('greet', { source: 'opener' })`，不跑内容识别（这是招呼，不是视频反应）。
4. 已说过的句子存 `chrome.storage.local` 的 `smOpenerSeen`，连续刷新不会复读。
5. 写入聊天记录用 `appendOpening()`，标记 `seed`：可见但不进历史，避免空会话污染列表。
6. 重新触发时机：同一天内切换标签页不重复；跨天回来（SPA 切换，不刷新）重新打招呼；插件从关闭状态重新启用也打招呼。`openerSaid` 防重。

### 2.2.1 会话（多对话）

1. 标题栏「新对话」→ `newSession()`：先 `stopStreaming()`，丢掉被打断的半截 assistant 消息，`persistSession(true)` 归档当前会话，再重置 `sessionId` / `sessionStartedAt` / `videoCount` / `messages`，显示引导语。
2. 归档保留 `lastAnalysis`（视频锚点），新对话仍针对当前视频。
3. 历史列表「记录」包含**当前会话**（带 `.cur` 高亮，按钮显示「当前」且禁用）。当前会话的「删除」也禁用：删的只是存档，活动消息下次保存会写回来。
4. **排序按 `startedAt`（建立时间）降序，不是 `endedAt`**。`core.js` 的 `byStartedAtDesc()` 同时用于 `normalizeHistory()` 和 `addSessionToHistory()`；继续聊一个旧会话不会让它跳到列表顶部。`describeSession()` 的时间标签也用 `startedAt`，与排序一致。
5. 空会话（只有 seed 引导语）不入历史：`currentSession()` 过滤 `seed` 与空内容。

### 2.3 服务端情绪底色

`server/src/prompts/zh.ts` 的 `pickChatColor(input)` 按用户这句话定本轮底色：

- 想哭 / 难过 / 委屈 → `心疼` → `sad`
- 烦 / 累 / 焦虑 → `关心` → `greet`
- 笑死 / 哈哈 → `被逗乐` → `laugh`
- 打招呼 → `关心` → `greet`
- 生气 / 气死 → `炸毛` → `angry`
- 震惊 / 不会吧 → `震惊` → `shocked`
- 问视频 / 为什么 / 问号 → `好奇` → `confused`
- 推荐 / 换一个 / 无语 / 离谱 / 服了 / 就这 → `嫌弃` → `annoyed`
- 谢谢 / 懂了 → `有点得意` → `happy`
- 种草 / 想去 / 下单 / 入坑 / 追更 → `有点上头` → `excited`（仅 `tone === 'maomao'`）
- 其他（无情绪词）：**配额补位**，见 2.3.1

**优先级：内容匹配 > 配额补位**。`matchChatColor()` 命中就直接用，配额不覆盖用户真实情绪。

### 2.3.1 表情配额（均衡分配）

1. 目的：9 种表情都能出现，避免少数几种霸屏。
2. 客户端 `state.emotionTally` 记本会话每种表情出现次数，只在 `source === 'assistant'` 时计数（`setEmotion` 内）；随 `/v1/chat` 请求体的 `emotionTally` 上报。`buildChatBody` 会用 `normalizeEmotionTally()` 过滤未知 id、钳制范围。
3. 服务端 `pickBalancedColor()`：取计数**最低**的情绪，平局用 `requestId` 做稳定轮转。`EMOTION_TO_COLOR` 必须覆盖全部 9 个 id，缺一个该表情就永远选不到。
4. 服务端不存任何状态（重启/多标签页无分叉）；计数随会话存在 `smHistory` 的 `emotionTally` 字段里，`newSession()` 清零，`loadSession()` 恢复。
5. 计数缺失或畸形时按 0 处理，只会让选择更均匀，不会报错。

> 曾有的缺口（已修）：`COLOR_TO_EMOTION` 缺 `excited`，聊天路径根本到不了「兴奋」；`FALLBACK_COLORS` 只有 4 项；「嫌弃」只匹配「推荐/换一个」，无语/离谱/服了全落进配额。

prompt 会写「这一轮的情绪底色：X。用具体判断、吐槽或关心带出来，不要直接说情绪名」。这个底色只是**提示**，不是用户情绪分类；客户端正文识别优先。

不要把它改成随机数，也不要用用户消息直接切图标。服务端底色和客户端关键词是两套信号；出现冲突时以正文为准。

## 3. 9 个情绪 id

`sad` 委屈 / `happy` 开心 / `annoyed` 嫌弃 / `angry` 生气 / `laugh` 大笑 / `excited` 兴奋 / `greet` 打招呼 / `confused` 疑惑 / `shocked` 震惊。

`shared/emotions.js` 支持 id、英文别名、中文标签；例如 `Emotions.get('joy') === happy`。`Emotions.detect()` 返回 `{ id, label, score, matched }` 或 `null`；`fromMood()` 用于把 analyze 的 `mood` 映射成情绪。

## 4. 常用命令

### 4.1 服务端

```powershell
cd D:\code\video-buddy\server
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run dev
```

> 当前 Windows PowerShell 执行策略会拦截 `npm.ps1`，统一用 `npm.cmd`。

### 4.2 扩展语法

```powershell
cd D:\code\video-buddy
node --check extension/content/buddy.js
node --check extension/background.js
node --check extension/shared/emotions.js
node --check extension/shared/core.js
# 共享规则的五个文件服务端也 import，改完一并检查
node --check extension/shared/persona.js
node --check extension/shared/text-core.js
node --check extension/shared/guards-core.js
node --check extension/shared/voice-filter.js
node --check extension/shared/zh-prompt.js
# 打包脚本本身
node --check extension/tools/pack-extension.mjs
```

> 共享文件里**不要写含 `*/` 的 JSDoc**：`background.js` 的注释里写过 `` `https://*/*` ``，其中的 `*/` 提前闭合了块注释，`node --check` 报 `Unexpected token '*'` 而报错行号完全指不到真凶。

### 4.2.1 设置项取值区间（改区间前必读）

`core.js` 里每个数值设置都有命名常量（`DWELL_MIN`、`REPEAT_DWELL_MIN`、`COOLDOWN_MIN`…），`normalizeSettings()` 和 `popup.html` 的 `min`/`max` 必须一致；`extension-core.test.ts` 有一条测试直接读 HTML 比对，两边改动不同步会红。

**下限是按服务端额度反推的，不是审美。** 服务端默认 `RATE_ANALYZE_PER_MINUTE = 6`（`server/src/config.ts`），而一次反应至少间隔 `dwellSeconds`（tick 要 `accumulated >= goal` 才发），所以滚动 60 秒窗口内最多 6 次，正好卡在额度上，不需要留余量。

| 设置 | 区间 | 依据 |
| --- | --- | --- |
| `dwellSeconds` | 10–120，默认 10 | 60/10 = 6 次/分 = 服务端额度。旧下限 3 秒 = 20 次/分，快速刷视频几乎全是 429，用户看到的就是「对话中断」 |
| `repeatDwellSeconds` | **0 或 20–600**，默认 60 | 0 = 不复聊；任何正数低于 20 都按 20 算（`normalizeRepeatDwell()`），否则单个长视频就能打满额度。**0 必须保持为 0**，不能被 `max(min, v)` 抬成最小值 |
| `cooldownSeconds` | 10–300，默认 45 | 只在失败后生效；0 等于失败后立刻重试，正好撞回刚吃到的 429 |
| `bubbleSeconds` | 6–120，默认 20 | 纯展示。低于一句中文的阅读时间就是噪音 |
| `emotionHoldSeconds` | 0–60，默认 6 | 纯展示。0 = 保持到下次变化；超过一分钟看起来像卡住 |
| `limitMinutes` | 1–600，默认 30 | **没有收紧**：不发请求，且 1 分钟是限时功能的端到端回归用的档位 |
| `limitEnabled` | 固定 `true` | 产品边界：到点关视频始终开启，不允许关闭；旧 `false` 归一为 `true` |
| `limitCooldownMinutes` | 0–720，默认 10 | 同上。0 = 只关一次 |
| `limitCloseSeconds` | 0–30，默认 5 | 纯本地。旧 core 允许 60 而 popup 只到 30，手改配置会得到 UI 无法撤回的行为 |
| `nudgeAfterMinutes` | 1–10，默认 5 | 沉默多久开始催；5 秒间隔固定 |
| `nudgeLimitCount` | 3–60，默认 10 | 催满多少次关页；上限约等于 5 分钟催促 |
| `ballSize` | 40–96，默认 60 | 1–2 个抖音头像大小 |

`DEFAULTS` 里每个值都必须落在自己的区间内，否则 `normalizeSettings()` 会静默改掉默认值，popup 显示的和实际生效的就对不上（这条也有测试守着）。

### 4.3 运行与健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

期望看到 `provider: "deepseek"`、`configuredProvider: "deepseek"`、`providerFallback: false`。如果返回 mock，先看 `server/.env.local` 是否被加载，不要改 `server/.env`。

### 4.4 验收清单

改完代码至少确认：

- `npm.cmd test` 全部通过（当前 294 个，以实际输出为准）
- `npm.cmd run typecheck` 退出码 0
- `npm.cmd run build` 退出码 0，且 `rm -rf dist && npm.cmd run build` 干净构建后 `node dist/server/src/index.js` 能起、`/health` 正常、启动日志里**没有** `failed to load lexicon`（emit 路径或数据路径改错时只会静默降级，见 §4.6）
- 全部扩展 JS 的 `node --check` 退出码 0（§4.2）
- `/health` 的 provider 符合预期
- 打包：`node extension/tools/pack-extension.mjs` 后 ZIP 里有 `shared/persona.js`、`shared/text-core.js`、`shared/guards-core.js`、`shared/voice-filter.js`、`shared/zh-prompt.js`，且没有 `tools/`、`server/`、`.pem`、`.env*`
- 直连：`node extension/tools/direct-check.mjs` 25 项全过（不需要 Key，见 §4.7.1）
- 网站：`node tools/pack-site.mjs --zip` 后 `site-dist.zip` 的条目里有**位于归档根部**的 `404.html`（`unzip -l` 或 `pack-site.test.ts`），且用 `cd site-dist && node ../site/serve.mjs` 起本地预览后 `node tools/check-deploy.mjs --url http://127.0.0.1:4173` 11/11（见 §4.8）
- 人工回归（报额度）：全新配置，刷视频等到第一次开口，气泡里先出现「今天设的是 N 分钟」再出视频反应；再聊几句不会重复报；点「新对话」后会再报一次
- 人工回归（催促）：打开抖音，面板里什么都别发，等默认 5 分钟（或把设置调到 1 分钟）——每 5 秒冒一句以「喵」结尾的催促；期间悬浮球进度环**停住不动**；随便发一句，催促立刻停、进度环从原处继续走
- 人工回归（催促·开关）：popup 里取消「停留后主动搭话」，等 5 分钟不应有任何催促；切到别的标签页等 5 分钟也不应有（回来看见的是重新开始，不是攒了一批）
- 人工回归（催满关页）：popup 里把「催促最多」拉到 3 次、冷静期设 2 分钟，打开抖音什么都不发——等到沉默触发后第 3 次不是说催促而是关页台词（含「3」）、5 秒后标签页关闭；2 分钟内重开说「还敢点开」再关一次；等过 2 分钟再打开，剩余额度**小于**关页前的剩余（额度没有因为被关页而重置）
- 人工回归（到点关视频锁定）：popup 里没有可取消的开关，只显示「始终开启，不可关闭」；把「每日时长」改成 1 分钟仍会到点关页，说明锁的是开关不是参数
- 人工回归：发“生气”时图标不立刻变；AI 回复结束后才变；中性回复靠 `done.emotion` 兜底
- 人工回归（会话）：点「新对话」后旧对话出现在「记录」里；继续聊旧对话，它在列表中的位置不变
- 人工回归（喵）：发一句普通消息，回复结尾有且只有一个「喵」；发「就这」确认图标仍是 `annoyed`（后缀不影响识别）
- 人工回归（招呼）：刷新抖音页面，气泡出现一句招呼且图标是 `greet`；连续刷新两次句子不同；关掉服务再刷新，招呼仍出现
- 人工回归（配额）：连发 9 句中性消息（如「接着聊」「然后呢」），9 种表情应基本各出现一次；发「笑死我了」时仍立即变 `laugh`（内容优先于配额）
- 人工回归（红点）：触发任意视频反应，悬浮球右上角不应出现红点 —— 2026-10-24 已确认
- 人工回归（广告）：刷到带「广告」标签的视频，图标应是 `angry`，气泡内容含「过分」或「气人」；刷到普通视频不应误判成广告 —— 2026-10-24 已确认
- 人工回归（长视频）：设复聊间隔 20s，停留 10s 开口一次，再等 20s 又说一句（记录标注「接着说」，视频编号不变）；刷走再刷回来，重新等 10s 才开口 —— 2026-10-24 已确认（区间已于当日重定为 10s/20s，逻辑不变）
- 人工回归（区间）：popup 里把「停留秒数」填 1、「冷却秒数」填 0、「复聊间隔」填 5，保存后应分别变成 10 / 10 / 20；「复聊间隔」填 0 保存后仍是 0（不复聊，不能被抬成 20）。快速连刷 12 条视频，气泡应基本每条都出，而不是刷几条后长时间没反应（那就是撞 429 了）
- 人工回归（不卡顿）：在抖音首页往下连刷 2 分钟，开发者工具 Performance 面板录一段，长任务（>50ms）应基本没有；悬浮球计时环照常走
- 人工回归（提时长）：连刷 6~8 条不同视频，气泡里不应出现「八秒 / X 秒 / 看多久」这类说法；连聊 5 轮，回复里也不应冒出秒数
- 人工回归（截图）：开发者工具 Network 里看 `/v1/analyze` 请求体，`images[0]` 应是一张 2×2 拼图、每格右上角有序号；请求体里应只有 `videoBucket`，没有秒数
- 人工回归（气泡头像）：面板里每条 AI 消息左侧都有 36px 圆形头像（能一眼分出嫌弃和生气）；刷到广告时该条头像是 `angry`、和悬浮球一致；发消息期间先显示当前情绪的头像，回复结束换成识别结果；用户消息没有头像；切到「记录」再切回旧对话，每条头像保持不变
- 人工回归（回退）：找一条 canvas 取帧失败的视频（或临时在 `frames.grab` 里强制 `blocked = true`），确认截图里**不含**悬浮球和气泡
- 人工回归（限时默认值）：全新配置（`chrome.storage.local` 里删掉 `settings` 后重开 popup）应显示「到点提醒并关闭网页」**未勾选**；而已经用过限时的旧配置升级后仍是**勾选**状态——这条专门守 §2.1.8 的旧配置兼容
- 人工回归（主动搭话开关）：在 popup 里取消勾选「停留后主动搭话」→ 刷新抖音页面，**不应出现招呼**，停 10 秒也不开口；点悬浮球仍能打开聊天面板，发消息仍有回复，回复结束仍换表情。重新勾选并刷新，招呼和视频反应都回来
- 人工回归（截图开关）：取消勾选「把画面截图一起发给模型」→ 刷一条视频，Network 里 `/v1/analyze`（或直连的 `chat/completions`）请求体应**没有 `images` 键**，气泡仍正常出现
- 人工回归（测试连接真的连）：直连模式下故意把 Key 改错一位，点「测试连接」应报「模型拒绝了访问令牌」而不是「已就绪」；空 Key 应报「还没填 API Key」；改回正确 Key 才显示「直连已就绪」并带延迟毫秒数
- 人工回归（限时）：把「每日时长」设成 1 分钟、「再打开时」设成 2 分钟，刷视频约 1 分钟后气泡说话且图标变 `angry`，5 秒后标签页自动关闭；2 分钟内重新打开抖音，它说另一句、5 秒后再关一次（点开就被关，不等 1 分钟）；等过 2 分钟再打开，恢复正常且重新给满 1 分钟。暂停视频挂机 5 分钟不应触发
- 人工回归（限时·切后台）：停在抖音但切到别的标签页放 5 分钟，回来不应触发限时（只算前台播放时间）
- 人工回归（限时·多标签页）：开两个抖音标签页各刷一段，看 `chrome.storage.local` 的 `smLimit.usedMs` 应是一条累计总额而不是两次独立计数；两个标签页加起来到点只关当前在看的那个，另一个继续开着的也不该说「还敢点开」
- 人工回归（键盘）：面板输入框里打字，抖音的快捷键（`J` / `K` / 空格等）不应被触发；Enter 正常发消息、Shift+Enter 换行、Escape 关面板
- 人工回归（直连）：先跑 `node extension/tools/direct-check.mjs`（§4.7.1，免费）；发布前再用真 Key 走一遍 §4.7.2——重点是保存时**必须弹出授权请求**，不弹就是权限请求又被挪进 service worker 了
- 人工回归（升级不改道）：已经配置好服务端地址的老用户，升级后 popup 仍是「连自己的服务」，不需要重新填任何东西

### 4.5 公开分发打包

```powershell
node extension/tools/pack-extension.mjs
# 产出 releases/shangtou-miaomiao-v<version>.zip
```

1. **白名单打包，不是排除法**。文件清单从 `manifest.json` 反推（content scripts / service worker / popup / icons / `web_accessible_resources`），所以新增文件默认**不进包**，要显式加。排除法会失败开放：漏一条规则就发出一个密钥。
2. **service worker 的依赖不在 manifest 里**：`background.js` 用 `importScripts()` 拉 `persona.js` / `text-core.js` / `guards-core.js` / `voice-filter.js` / `zh-prompt.js` / `core.js`，manifest 一个字都没提（MV3 没有模块加载器，这是唯一写法）。打包脚本因此**从 `background.js` 源码里解析 `importScripts()` 的字面量**补进白名单。
   - 这里曾经真的漏过：共享层搬完之后，包里有 20 个文件、manifest 看着完整，实际这 5 个全缺，service worker 装在用户机器上第一行就报错。**不要再手维护第二份清单**——手维护的清单正是漏掉的原因。
   - `server/test/pack-extension.test.ts` 解析 ZIP 中央目录逐个比对，证明它在 bug 存在时会红（已手动回退验证）。
3. **`extension/tools/` 不进包**（里面有 47KB e2e harness 和图标生成脚本）。脚本会拒绝任何 `tools/`、`test/`、`.backup-` 前缀以及 `.pem` / `.env*` 条目。
4. ZIP 条目名一律正斜杠。Windows 上 `path.join()` 产出反斜杠，严格读取器会把 `popup\popup.js` 当成一个文件名。
5. 发布前必须确认解压后**不含** `extension.pem`、`server/`、`.env*`。`extension.pem` 在仓库根目录，永远不要从仓库根执行打包或部署类命令。
6. 版本号改 `manifest.json` 的 `version`，ZIP 文件名自动跟随。

### 4.6 共享规则文件（`extension/shared/*.js`）与服务端构建布局

1. **为什么是 classic script 而不是 ESM**：MV3 content script 没有模块加载器，只能按顺序当普通脚本执行；项目也禁止给扩展加构建步骤（§6.3）。所以这些文件是 IIFE —— 既给浏览器挂 `globalThis.Sm{X}`，也给 Node `module.exports` 留口子（Node ESM 里 `import '...js'` 只求副作用，`globalThis` 上就有了）。
2. **服务端只做薄封装**：`persona.ts` / `zh.ts` / `guards.ts` / `voiceFilter.ts` / `lib/text.ts` 读 `globalThis` 再导出，规则本体只有一份。改规则改 `extension/shared/*.js`，不要在两处各写一遍。包装层里**不许再长出实现**——一旦有人图省事在 TS 里补一段，两份规则就开始漂移，而漂移是静默的。
3. **加载顺序有依赖**：`text-core.js` 是最底层；`guards-core.js` 依赖它；`voice-filter.js` 依赖 `guards-core.js`；`zh-prompt.js` 依赖 `text-core.js`。依赖是**惰性取值**（用的时候才读 `globalThis`），所以只 import 下游模块**不会**自动把上游拽进来——包装层必须显式逐个 import。少一行，测试会报「requires X to be loaded first」。
4. **`rootDir` 是 `..`，emit 比原来深一层**：入口变成 `dist/server/src/index.js`，共享脚本落在 `dist/extension/shared/`，`package.json` 的 `start` 已跟着改。两份 tsconfig 的 `include` **逐个列出**这五个 js，不用 `../extension/shared/*.js` 通配——通配会把 `core.js` / `emotions.js` / `keyboard-guard.js` 也拷进 dist。
5. **数据文件的相对路径不能写死**：`../../data/*.json` 在 emit 深一层后就指错地方，启动时只打一行 `failed to load lexicon` 然后带空词库继续跑（静默降级，很难发现）。改走 `src/lib/dataPath.ts` 的 `dataFile(name, import.meta.url)`，从模块位置逐级上溯找 `data/`，`tsx` 跑 `src/` 与 `node dist/...` 两种布局都能命中；找不到直接抛错。
6. **`node:crypto` 换成 FNV-1a**：`text.ts` 的 `hashShort` 用 sha256，service worker 里没有这个模块。共享层改用 `SmText.seed()`（FNV-1a，32 位）。副作用是表情配额的平局轮转换了种子，所以 `buildChatMessages` 的轮转那一行在跨实现对比里要屏蔽掉，其余内容必须逐字节相同（`direct-parity.test.ts`）。
7. **刻意留在服务端的**：`trends/*`（`node:fs` 读词库）和 `lib/text.ts` 里的 `hashShort` / `isAbortError` / `delay`。放进 `extension/` 会让 content script 一加载就崩——直接违反原则 1。

### 4.7 直连模式测试

直连模式有两条独立的验证路径，**先用脚本，再上真 Key**。

#### 4.7.1 脚本验证（免费，每次改完都跑）

```powershell
node extension/tools/direct-check.mjs          # 25 项
node extension/tools/direct-check.mjs --keep   # 保留临时 profile 排查
```

headless Chrome 加载真实扩展，指向本地假模型服务。**不需要 API Key、不花 token。**

覆盖：service worker 的 `importScripts()` 链完整（打包漏文件时这里最先红）、`normalizeSettings` 保住 direct、loopback 免授权、权限请求在 popup 而非 SW、analyze 成功且 `reaction` 只有一个「喵」、`Authorization` 用的是用户 Key、`stream:false` + `json_object`、广告侧标签强制 `isAd`、聊天多片流式且结尾一个「喵」、`done.emotion` 存在、401→`UPSTREAM_AUTH` 不可重试、5xx→可重试、非 JSON→`UPSTREAM_PROTOCOL`、空 Key→`NO_API_KEY`。

**为什么用本地 stub 而不是真 Key**：真 Key 跑一次要花钱、要联网、会因为上游改动而 flaky，没法在每次改动后跑。stub 只能证明扩展这一侧正确，不能证明 DeepSeek 的行为——所以还有 4.7.2。

**loopback 例外是测试的前提**：`normalizeApiBaseUrl()` 只接受 https，**唯一例外是 `http://127.0.0.1` / `http://localhost`**。这两个 origin 本来就在 `host_permissions` 里（host pattern 忽略端口，server 模式要用），所以放行不新增任何权限，且流量不出本机。

#### 4.7.2 真 Key 验证（发布前至少一次）

1. `chrome://extensions` 加载 `extension/`，打开 popup。
2. 「方式」选「直接用 API Key」，填真实 Key，「API 地址」保持 `https://api.deepseek.com`。
3. 点保存 —— **必须弹出授权请求**。没弹出来就说明权限请求又被挪进 service worker 了（手势过不了 `sendMessage`）。
4. 用 DevTools 的 Network 面板过滤 `chat/completions`，确认：请求头 `Authorization: Bearer sk-...`、`model` 是 `deepseek-flash`。
5. 刷抖音，等一条视频开口；聊 3 轮，确认回复末尾有且只有一个「喵」、表情在回复结束后才变。
6. 故意把 Key 改成错的，确认气泡提示的是「模型拒绝了访问令牌」而不是卡住。

**用真 Key 时最容易踩的两件事**：
- **`MODEL_VISION` / `MODEL_CHAT`**：`DIRECT_CONFIG` 写死 `deepseek-flash`。换模型要改 `background.js` 的 `DIRECT_CONFIG`，同时改 `direct-parity.test.ts` 的断言。
- **模型不支持 `response_format: json_object`** 时会返回 400 → `MODEL_UNAVAILABLE`。这不是 Key 的问题，别去反复换 Key。
- 直连模式**没有热点/俚语注入**（那需要 `node:fs` 和实时抓取），`trendCandidates` / `slangCandidates` 恒为空，prompt 会显示「（无）」。这是有意的取舍，不是 bug。

#### 4.7.3 判断模型能力（拿真 Key 之后第一件事）

`deepseek-flash` 能不能用于直连，取决于三件事，**必须分别验证**，不要一次全改再看结果：

**① 视觉能力（analyze 路径）**

DevTools → Network 过滤 `chat/completions`，刷一条视频触发 analyze，看响应：

| 现象 | 结论 |
|---|---|
| 200 + `choices[0].message.content` 是 JSON | 视觉可用，什么都不用改 |
| 400，`error.message` 提到 image / vision / content type | 该模型不吃图片。**改 `DIRECT_CONFIG.visionModel` 为支持视觉的模型** |
| 200 但 content 是「我看不到图片」这类话 | 同上，模型在忽略图片 |
| 200 但 content 不是 JSON | `json_object` 被忽略了，见 ③ |

**② `response_format: json_object` 支持（analyze 路径）**

- 返回 400 且 `error.message` 提到 `response_format` / `json` → 不支持。
- 改法：删掉 `background.js` 里 analyze 请求体的 `response_format: { type: 'json_object' }` 那一行。`directParseJson()` 已经能从 ```json 围栏和散文里捞出 JSON，所以去掉后大概率仍能用，只是偶尔要多解析一次。
- 删了之后 `direct-parity.test.ts` 里那条断言也要同步改——两边不同步会红。这是有意的：让「能力探测的结论」在代码里留痕。

**③ 流式（chat 路径）**

聊一句，看 Network 里那个请求：

- 响应头 `content-type: text/event-stream` 且面板里能看到多帧 `data:` → 正常。
- 200 但 `content-type: application/json`、只有一整块 → 模型不支持流式。气泡会一次性蹦出整句。可接受但体验差；要修就得在 `directStreamChat` 里加「非 SSE 时整体当一片」的分支。

**判断完的落地方式**：把结论写进 `DIRECT_CONFIG` 上方的注释（模型名 + 已验证的能力），改 `direct-parity.test.ts` 对应断言，然后重跑 `direct-check.mjs` 确认 loopback 路径没被连带改坏。**不要**为了「以后可能换模型」加一层能力探测的运行时逻辑——那会让每次请求多一次失败重试，而模型是发布时定好的。

### 4.8 网站发布（Cloudflare Pages 直接上传）

```powershell
cd D:\code\video-buddy
node extension/tools/pack-extension.mjs --out site/download   # 安装包
node tools/pack-site.mjs --zip                                 # site-dist/ + site-dist.zip
```

Cloudflare Dashboard → Workers & Pages → Create → Pages → **Upload assets**，上传 **`site-dist` 文件夹本身**或 **`site-dist.zip`**。它的提示是「The contents of your zip file or folder will be used to deploy your project」——取的是**内容**作为站点根目录，所以拖文件夹本身是对的，**不需要进去全选再拖**（曾把这条写反过）。

1. **`tools/pack-site.mjs` 是白名单**：只复制 5 个页面（含 `404.html`）、`styles.css`、`app.js`、`assets/**/*.png`、`download/*.zip`。`site/README.md`（含内部决策：为什么不上 Firefox、为什么暂不上架）和 `site/serve.mjs`（本地预览服务）不进发布目录。新增页面必须显式加进 `PAGES`。
2. **四条守卫，直接 `exit 1`**：`download/` 里没有 ZIP；`app.js` 的 `DOWNLOAD_URL` 与磁盘上的 ZIP 名不一致（改 `manifest.json` 版本却没同步时会发生）；页面引用了没被复制的文件；**`404.html` 没被 staged 到归档根部**。这四件事单独看都不会报错，只会让站点「看着正常但下不到扩展」或「看着正常但每个错链接都返回 200」。
3. **ZIP 条目位于归档根部，不带 `site-dist/` 前缀**。多一层前缀不报错，但整站会被部署到下一级目录，`/` 上什么都没有。`pack-site.test.ts` 解析中央目录断言这一点（已回退验证会红）。
4. **ZIP 写入逻辑只有一份**：`tools/zip-writer.mjs`，`pack-extension.mjs` 和 `pack-site.mjs` 都 import 它。两个发布路径各写一份的话，修好一处、另一处仍是旧的。
5. **`site/404.html` 不是装饰，它决定未知路径的状态码**。Cloudflare Pages 只有在**部署根目录**存在 `404.html` 时才不再把项目当成单页应用；否则任何拼错的地址都返回 `index.html` + **200**，`/typo` 和 `/admin` 对爬虫和链接检查器都与真页面无异（软 404），而浏览器里完全看不出来。所以：① packer 把 `404.html` 放进 `PAGES` 且断言它落在归档根部（放进子目录不生效，行为会静默回退）；② `site/serve.mjs` 的未知路径也返回它并带 404 状态，否则这个页面只能在部署后看到、它自己的链接在那之前完全没被点过；③ `serve.mjs` 同时补了 `/demo` → `/demo.html` 的映射与 `.zip` 的 `application/zip`，否则本地预览和生产行为不一致，检查脚本会为错误的理由失败。
6. `site-dist/` 与 `*.zip` 都在 `.gitignore` 里，是构建产物，不要提交。
7. **部署后跑一次线上检查**（免费、不用 Key）：

   ```powershell
   node tools/check-deploy.mjs                                   # 默认打 https://shangtou-meowmeow.pages.dev
   node tools/check-deploy.mjs --url https://预览域名.pages.dev   # 换 URL
   ```

   它用 headless Chrome 打开真实站点，而不是 curl：`site/app.js` 的下载按钮是「HEAD 探测 → 换弹窗内容」，路径写错、方法写错、CORS 挡掉都会让页面**看着完全正常**但每个访客拿到的都是回退说明弹窗——纯 HTTP 状态码检查发现不了这一段。11 项覆盖四个页面各自渲染出自己的内容、从**线上** `app.js` 里读出 `DOWNLOAD_URL` 再拿它去探测、点真实按钮确认弹窗里有 `.zip` 链接、`README.md` / `serve.mjs` 返回 404 且不泄露、未知路径返回 **404 且响应体是 404 页**。
   - 「四个页面渲染」还要求 `document.title` 是**这一页自己的**标题：只看有没有 `<h1>` 的话，路由坏掉时返回的 `404.html` 同样有标题和标语，检查会绿。
   - 「没有泄露」同时看**响应体**和状态码：正文里不能出现内部部署说明，状态也不能是 200。历史原因记一笔——在 `404.html` 之前，Cloudflare 对未知路径回落 `index.html` 并返回 200，那时只能靠响应体区分。
   - 已用 `--url https://example.com` 验证它会红（退出码 1）；也在本地 `site-dist/` 上跑过 11/11（`serve.mjs`），并确认把 `404.html` 移出白名单时 packer 会 `exit 1`。
   - **部署是人工步骤**：直接上传由人在 Cloudflare Dashboard 完成，脚本只负责「产出」和「验证线上」。不要用命令行代替这一步。

## 5. 环境与密钥

- `server/.env.local` 优先于 `server/.env`：`loadEnvFiles()` 先加载 `.env.local`，再加载 `.env`，且不覆盖已存在的变量。
- 当前运行应为 `MODEL_PROVIDER=deepseek` + `DEEPSEEK_API_KEY`；模板见 `server/.env.local.example`。
- **不要修改 `server/.env`**（历史配置，保持 mock 不动）；换 key 或切 provider 改 `server/.env.local`。
- 没填 key 时服务端不会起不来：`createProvider()` 打 warning 并回退 mock；`/health` 的 `configuredProvider` + `providerFallback` 可诊断。
- 401/403 → `UPSTREAM_AUTH`（不可重试）；400/404 → `MODEL_UNAVAILABLE`（多半模型名错）；其他 → `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT`。
- `.env*`、`extension.pem` 不提交、不粘贴到聊天、不写进日志。

## 6. Claude Code 对接

### 6.1 启动

1. 用 VS Code 打开 `D:\code\video-buddy`，信任工作区。
2. 打开 Claude Code 面板（侧边栏 Claude 图标，或 Windows 下 `Ctrl+Esc`）。
3. 第一条消息建议：

```text
先读取 CLAUDE.md。只做只读检查，执行 /handoff-check，不要改文件。
```

4. 需要改代码时，先让 Claude Code 给出最小改动计划，再批准写入。
5. 本机已安装 Claude Code `2.1.153` 和 VS Code 扩展 `anthropic.claude-code`。PowerShell 会拦截 `claude.ps1`：命令行用 `claude.cmd`（不要直接输 `claude`），或直接在 VS Code 面板里用。

```powershell
cd D:\code\video-buddy
claude.cmd
```

6. 首次执行测试命令时 Claude Code 会请求 Bash 权限，按需批准即可；不要使用 `--dangerously-skip-permissions`。

### 6.2 自定义命令

- `/handoff-check` — 交接前完整验收：测试、类型、构建、扩展语法、表情链路、health。
- `/emotion-check` — 只读检查 9 情绪资源 + AI 回复驱动链路。
- `/chat-quality-check` — 只读检查人设、视频锚点、去重、Mock 分流、情绪底色、过滤。

默认都只检查、不改文件；需要修复时明确说「按报告修」。

### 6.3 修改守则

- 不要恢复“用户输入触发表情”的旧逻辑。
- 改 `server/` 后至少跑 `npm.cmd test` + `typecheck`；改扩展跑 `node --check`。
- 改情绪识别/映射必须补测试（`server/test/extension-core.test.ts` 或新增）。
- 不改 `manifest.json` 里 buddy 那条 content script 的顺序（`core.js` → `emotions.js` → `buddy.js`），也不改它 `document_idle` 的时机；`keyboard-guard.js` 必须留在 `document_start` 那条。图标路径保持 `assets/emotions/{id}-128.png`。
- 不引入扩展构建步骤或框架；扩展是原生 JS。`extension/shared/` 下的 `persona.js` / `text-core.js` / `guards-core.js` / `voice-filter.js` / `zh-prompt.js` 是**共享规则**，服务端 import 它们，改完两边一起验（§4.6）。
- 服务端那五个 wrapper（`prompts/persona.ts`、`prompts/zh.ts`、`safety/guards.ts`、`safety/voiceFilter.ts`、`lib/text.ts`）**不允许再长出实现**。要改规则改 `extension/shared/*.js`。加新规则时先问一句「扩展要不要用」：要，就进共享文件；不要，才留服务端。
- **直连模式和服务端模式必须喂给模型同样的 prompt 和同样的后处理**。加规则只改共享模块，不要在 `background.js` 里写第二份；`direct-parity.test.ts` 守着采样参数和后处理调用。
- 不往 `manifest.json` 的 `host_permissions` 里加模型域名：安装即授予，违背「不多要权限」。要加走 `optional_host_permissions`，在 popup 的提交处理里同步请求。
- 不读/写 `.env`、`.env.local`、`extension.pem`；不把 token 写进代码、日志或回复。
- 不把服务端情绪提示改成权威结果；客户端正文优先是有意设计。
- 改完更新本文件相关段落和命令。

## 7. 已知边界 / 下一步

1. 真实抖音页面回归仍需人工：加载扩展 → 刷新抖音 → 聊 5 轮，确认“发送时不切、回复结束才切”。
2. 9 个图标是从参考图裁切的原型；正式发布前需要重绘原创角色，或确认模板授权。
3. 情绪识别是关键词 + 语气规则，不是模型分类；误判时先加测试再调，不要只加裸词（例如 `就这` 会误伤 `就这么点事`）。
4. 服务端 hint 是粗粒度兜底；正文没有情绪词时才会用到。
5. 可评估服务端返回 `emotion + confidence`，低置信不切；目前未实现。
6. `extension/tools/e2e.mjs` 可做浏览器回归，但 harness 页面的 manifest 需要补 `web_accessible_resources`（否则图标 404），且前台标签页会节流定时器，计时断言容易假失败。
7. 抖音没有稳定的公开广告 DOM 契约：`readAdLabel()` 是按常见 class/data-e2e 名猜的选择器集合，页面改版后可能失效（表现为广告不再被识别）。失效时应补选择器，**不要**放宽成「文案里含广告就算」。同一条广告在复聊间隔内可能再次触发（每次按新请求处理）。
8. 短视频自动循环不会重置 `firedCount`：同一个 15 秒视频连刷十几分钟，会按复聊间隔持续开口。这是当前取舍（循环与「长视频继续看」在页面上无法可靠区分）；如需抑制，可在 `tracker` 里按 `video.duration` 很短时下限流。
9. **网页的安装包不在仓库里**：`site/app.js` 的下载按钮先 `HEAD site/download/shangtou-miaomiao-v<version>.zip`，文件在才给下载，不在就退回说明弹窗（不会给一个 404 链接）。ZIP 是构建产物，被 `.gitignore` 的 `*.zip` 挡在仓库外，所以 `site/download/` 只提交 `.gitkeep`；发布前要跑 `node extension/tools/pack-extension.mjs --out site/download`，部署时整个目录一起上传。版本号跟 `manifest.json`，改版本要同步 `site/app.js` 里 `DOWNLOAD_URL` 那一个常量。
10. **浏览器支持与分发方式是有意的取舍（2026-10-24 定）**：只支持 **Chromium 内核**（Chrome / Edge 116+、Brave、Opera、Vivaldi）。**Firefox 不支持**——它的 MV3 至今没有 `background.service_worker`，而所有请求和截图都在这里；**Safari 不支持**（需另行封装）。网站已在首页 hero、安装页 FAQ、BYOK 步骤三处写明，不要改成含糊的「主流浏览器」。
    - **暂不上架商店**。安装走开发者模式加载，代价是 Chrome 每次启动提示「请停用开发者模式扩展程序」且**没有自动更新**；这条已在 `site/install.html` 如实写给用户。做了 Firefox 适配或决定上架时，先改这一条和网站文案，别让页面继续承诺手工安装的路径。

## 8. 变更记录（压缩）

- 2026-10-25 催满次数关页（§2.1.12）：催到上限就不再说催促，改说关页台词并进冷静期。**① 计数进状态机**：`spoken` / `exhausted` 放在 `createNudgeMachine` 里，`cap()` 是注入的 getter，所以假时钟能驱动、popup 改完不用刷新。first-cut 把计数写在 `buddy.js` 的 `onSpeak` 里，只能靠 `setTimeout` 绕开 `tick()` 尾部的 settle，既测不到也脆。**② 上限算最后一句话**：达到上限那一拍不说普通催促，直接 `onExhausted()` → `limiter.closeForNudge()` → `sayAndClose('nag')`，用户读到的最后一句是关页台词而不是又一句「人呢」。**③ 不白送额度**：新增 `limitAfterNag()`，保留当日已用时长再盖 `shutAt`（`limitAfterShutdown()` 会清零）。用 `sm:limitShutdown { reason }` 让后台区分两种关页；否则「不理猫」会变成刷额度的捷径。**④ 关页失败要解冻**：后台拒绝且 `window.close()` 也不生效时调 `nudge.release()`，否则一次关不掉的标签页会留下永久冻结的进度环和哑掉的猫。**⑤ 顺带修好 `scripted`**：`sayAndClose` 的台词原来没标 `scripted`，刷新后被当成模型说过的话。`nudgeLimitCount` 默认 10、区间 3–60，popup 放在「沉默催促」区块内。293 个测试通过，`typecheck` / `build` / 全部 `node --check` / `direct-check.mjs` 25 项全绿。

- 2026-10-24 线上站点检查：新增 `tools/check-deploy.mjs`（§4.8 第 6 条）。站点部署到 `https://shangtou-meowmeow.pages.dev` 后，curl 只能证明状态码和哈希；而 `site/app.js` 的下载按钮走的是「HEAD 探测 → 按结果换弹窗内容」，路径、方法或 CORS 任何一处不对，页面**看起来完全正常**，每个访客拿到的却是回退说明弹窗。脚本用 headless Chrome 打开真实 URL，从**线上** `app.js` 里读出 `DOWNLOAD_URL` 再拿它去探测，然后点真实按钮确认弹窗里出现 `.zip` 链接。另外 `README.md` / `serve.mjs` 的判断看**响应体**而不是状态码——Cloudflare 对未知路径回落到 `index.html` 并返回 200，状态码不证明任何事。10/10 通过；`--url https://example.com` 验证会红（8 项失败，退出码 1）。实测线上：四页哈希与本地一致、内嵌 ZIP 与本地字节相同、`/demo.html` → `/demo` 308 且保留查询串。

- 2026-10-24 网站发布目录 + 共用 ZIP 写入：新增 §4.8。`tools/pack-site.mjs` 白名单产出 `site-dist/`，`--zip` 同时产出 `site-dist.zip`（18 个条目**位于归档根部**，不带 `site-dist/` 前缀——多一层不报错，但整站会部署到下一级目录、`/` 上什么都没有）。ZIP 写入抽成 `tools/zip-writer.mjs` 一份，`pack-extension.mjs` 与 `pack-site.mjs` 共用；抽出来后重跑扩展打包仍是 25 个文件、`pack-extension.test.ts` 全绿。`pack-site.test.ts` 新增一条解析中央目录的断言（归档根 + 内嵌 `download/*.zip`），**已回退验证会红**。修正文档里写反的一处：Cloudflare 的提示是「The contents of your zip file or folder will be used to deploy your project」，**拖 `site-dist` 文件夹本身就是对的**，不需要进去全选；之前 `site/README.md` 与给用户的说明都是反的。245 个测试通过。

- 2026-10-24 发布前收尾：新增 §7.10。网站上线前补三件事。**① 写明兼容范围**：首页 hero、安装页 FAQ、BYOK 步骤三处说明只支持 Chromium 内核（Chrome / Edge 116+ 等），**Firefox（MV3 无后台 service worker）和 Safari 明确不支持**。**② 如实交代开发者模式的代价**：Chrome 每次启动会提示「请停用开发者模式扩展程序」、且没有自动更新；不解释的话用户会以为是装坏了。**③ 下载回退文案改写给访客看**：原来写的是「部署时把安装包放在 download/ 下」「自己构建 `node ...`」，那是给部署者的话，访客只会看到一堆无从下手的命令；同时删掉过时的「公开包正在打包」。已决定**暂不上架商店**，因此上述手工安装路径是当前正式路径，不是临时方案。提交 `f2e0b56`。

- 2026-10-24 与前端网页对接：新增 §2.1 第 7–8 条、§2.1.9 第 7 条、§7.9。网站已经把「悬浮球、截图、主动搭话、限时都能单独关闭」「测试连接」写成对用户的承诺，这一轮把它们补成真的，而不是把文案删掉。
  **① 两个新开关**：`proactive`（主动搭话）与 `captureEnabled`（截图），都和 `enabled` 一样**默认 `true`、缺失键也解析成 `true`**，所以升级不改变任何现有行为。`proactive` 同时罩住 `onDwell()` 的反应**和 `sayOpener()` 的开机招呼**——只罩前一半的话，关掉开关后猫仍会每次开页面都开口，网站承诺就是假的；限时关页台词不受它影响（那是执行限制，归 `limitEnabled`）。`captureEnabled` 关掉后 `capture` 直接是 `{ ok: false }`，请求体里不再出现 `images` 键。
  **② 修掉一个会让公开版「永远不主动开口」的 bug**：`onDwell()` 原来只查 `settings.appToken`，而 `direct` 模式既不显示也不写这个字段，于是**每一台全新 BYOK 安装都收不到任何主动反应**；用户自己的机器因为还留着早年 `server` 模式的 `appToken` 才看起来正常。改为 `core.js` 的 `modeConfigured(settings)` 单一判断点（`direct` 看 `apiKey`，`server` 看 `appToken`），加第三种模式时只改这一处。测试直接读 `buddy.js` 源码断言旧写法不能回来。
  **③ 「测试连接」现在真的连**：`background.js` 新增 `directPing()`，`GET {apiBaseUrl}/models`——OpenAI 兼容接口里的免费调用，能验 Key 又不花 token。旧实现只查本地状态，**错 Key 也报「已就绪」**，正好漏掉这个按钮唯一要抓的东西。`direct-check.mjs` 25 项（新增 4 项），其中一条把 `directPing` 换回本地检查就会红。
  **④ 网站文案改成指向真实控件名**（`index.html` / `install.html` / `setup.html`），「测试连接」的 FAQ 按 `directFailure()` 的三类错误重写，本地服务模式的选项名改成 popup 里实际的「连自己的服务（需先启动）」。
  **⑤ 下载按钮接上真实安装包**：`site/app.js` 先 `HEAD` 一下 `site/download/shangtou-miaomiao-v<version>.zip`，在就给下载、不在就给构建说明，不会给 404 链接。ZIP 是构建产物（`.gitignore` 的 `*.zip`），`site/download/` 只提交 `.gitkeep`。239 个测试通过，typecheck / build 退出码 0，全部扩展 JS `node --check` 通过，`direct-check.mjs` 25/25，打包 25 个文件且无敏感文件。

- 2026-10-24 P2 BYOK 直连模式：新增 §2.1.9。`settings.mode` 全新安装默认 `'direct'`、旧配置留在 `'server'`（`legacyMode()`），**升级已装好的用户不会被静默改道**；`'direct'` 时 `background.js` 直接打用户的 `apiBaseUrl`，`Authorization: Bearer <自己的 Key>`，Key 只存 `chrome.storage.local`。`manifest.json` 只加 `optional_host_permissions: ["https://*/*"]`，不往 `host_permissions` 里塞模型域名——那是安装即授予；`popup.js` 在 submit **同步**调 `chrome.permissions.request()` 收窄到那一个 origin。**权限请求不能绕经 service worker**：用户手势过不了 `sendMessage`，原实现（popup → background → request）每次都返回「must be called during a user gesture」，弹窗根本出不来——已改为 popup 直接请求，并加断言守着。`normalizeApiBaseUrl()` 只收 `https://`，**例外是 loopback**（`127.0.0.1` / `localhost` 走 http），这两个 origin 本就在 `host_permissions` 里（pattern 忽略端口），放行不新增权限，也是 `direct-check.mjs` 能用本地假服务免费测试的前提。

  **共享层扩到全量**：`zh-prompt.js`（system prompt / 视频锚点 / 情绪底色 / 表情配额 / 角度去重 / BUCKET_HINT）和 `text-core.js`（纯文本工具 + FNV-1a `seed`）也搬进 `extension/shared/`，`zh.ts` / `lib/text.ts` 变成薄封装。`node:crypto` 的 sha256 在 service worker 里没有，改用 FNV-1a；代价是配额平局轮转换了种子，`direct-parity.test.ts` 因此屏蔽轮转行、断言其余字节一致。**两个模式必须喂同样的 prompt、跑同样的后处理**，否则「换个模式说话就变了」，而两边各自的测试都发现不了。

  **修打包漏文件**：`pack-extension.mjs` 的白名单从 manifest 反推，但 service worker 的 5 个 `importScripts()` 依赖 manifest 一个字都没提。改前实跑只有 20 个文件、`shared/persona.js` 等 5 个全缺——装到用户机器上 worker 第一行就报错，而清单看着是完整的。改成从 `background.js` 源码解析 `importScripts()` 字面量。新增 `pack-extension.test.ts` 解析 ZIP 中央目录逐个比对（不用字节搜索：正文是压缩的，会误命中），并已手动回退修复验证它会红。234 个测试通过。

- 2026-10-24 P1 共享规则去重：新增 §4.6。把「服务端和扩展都要用」的规则从 TypeScript 提到 `extension/shared/`，服务端改成薄封装，规则只留一份。**已搬走**：`persona.js`（人设，4 个 tone 的全部规则串）、`guards-core.js`（`withMaoSuffix` / `applyMaomaoStyle` / `NEUTRAL_BY_TONE` / `AD_REACTIONS` / `adReaction` / `neutralReaction`）、`voice-filter.js`（`createMaomaoStreamFilter`）。**刻意没搬**：`zh.ts` 与 `trends/*`，因为它们 `import` `node:fs` / `node:crypto`，进 `extension/` 会让 content script 加载即崩。形状是 IIFE 而不是 ESM——MV3 content script 无模块加载器且禁止构建步骤，文件同时挂 `globalThis` 和 `module.exports`，Node 里 `import '...js'` 求副作用即可。

  **构建布局跟着变**：`rootDir` `src` → `..`，入口移到 `dist/server/src/index.js`（`package.json` 的 `start` 已改）。这次位移暴露了一个**静默降级**：`trends/*` 里写死的 `../../data/*.json` 指进了 `dist/`，启动只打一行 `failed to load lexicon` 就带着空词库继续跑，`/health` 完全正常。改为 `src/lib/dataPath.ts` 的 `dataFile(name, import.meta.url)` 逐级上溯。`voiceFilter.ts` 必须显式先 import `guards-core.js`：`voice-filter.js` 到 `flush()` 才取 `globalThis.SmGuards`，漏掉这行 6 个测试红。两份 tsconfig 的 `include` 逐个列出三个 js（通配会把浏览器专用脚本也拷进 dist）。198 个测试通过，typecheck / build 退出码 0，干净构建后启动 `/health` 正常且无 lexicon 警告，`/v1/analyze`（mock）与 `/v1/chat` SSE 的 `喵` 尾和 `done.emotion` 实测正常。

- 2026-10-24 tick 开销 + 设置区间重定：新增 §2.1.6.1、§4.2.1。**① 每 400ms 的 tick 不再做排版**：`videoKey()` 原来走 `readScreenText()`，在 4 万节点的长 feed 上单次 tick 47–56ms（约 12% CPU）。拆成 `readCaption()`（仅 caption+hashtags，仍用于 `onDwell`）与 `captionSignature(video)`（`textContent`、不排版、限定在播放中视频的 item 内），`videoKey()` 只调后者；null 时有文档级回退，避免所有 `blob:` 视频共用一个 key。实测 38831 节点：旧 47–56ms → 新 0.001ms（6000 次合计 7.2ms）。**② 广告选择器分两段**：精确契约 `AD_CHIP_SELECTOR` 可整页查，泛化猜测 `AD_LOOSE_SELECTOR`（`[class*="tag" i] span`）限定在 item 内；无 item 时不回退整页。**③ 设置区间按服务端额度反推**：`DWELL_MIN` 3→10（60/10 = 服务端的 6 次/分，旧值 20 次/分导致快速刷视频几乎全 429）、`REPEAT_DWELL_MIN` 0→20 但**保留 0 = 不复聊**（新增 `normalizeRepeatDwell()`，`max(min,v)` 会把「关」抬成最小值）、`COOLDOWN_MIN` 0→10（0 等于失败后立刻撞回 429）、`BUBBLE_MIN` 4→6、`EMOTION_HOLD_MAX` 120→60、`limitCloseSeconds` 上限 60→30（与 popup 对齐）、`dwellSeconds` 默认 8→10（默认值必须落在自己区间内）。`limitMinutes` / `limitCooldownMinutes` **故意不动**：不发请求，且 1 分钟是限时端到端回归用的档位（收紧后 `limit-check.mjs` 3 项红）。新增测试：popup.html 的 `min`/`max` 与 `core.js` 常量逐项比对（这两份手维护列表以前漂移过）、`DEFAULTS` 落在各自区间内、区间与 6 次/分额度的算术关系。195 个测试通过；`limit-check.mjs` 15/15、`shared-check.mjs` 8/8。

- 2026-10-24 刷视频限时（跨标签页共享总额）：新增 §2.1.7。`core.js` 加 `smLimit` 状态与 `limitBudgetMs` / `limitCooldownMs` / `limitCloseDelayMs` / `limitSnapshot` / `limitAfterShutdown` / `limitCredit` / `dayKey` / `pickLimitLine` + `LIMIT_LINES` 两组台词；`buddy.js` 新增 `limiter` 模块，只累加「页面可见且视频在播放」的时间，到点切 `angry`、写聊天记录、显示气泡，等 `limitCloseSeconds` 后由 background 的 `sm:closeTab` 调 `chrome.tabs.remove`（用 `sender.tab.id`，页面传不进 tabId，并校验域名必须是抖音）。关页瞬间写 `shutAt` 建立冷却期，冷却期内打开只说一句就再关一次、不计时、不续期。冷却是「不续期」而非「续期」，否则反复探头会把 10 分钟变成无限期。popup 新增「刷视频限时」四项设置。

  **跨标签页**：账本搬到 service worker（`background.js` 的 `limitLedger`），content 只发 `sm:limitTick`。原因是 `chrome.storage` 没有 compare-and-swap——每个标签页各自 `get` + `set` 会读到同一基数，后写的把先写的时长抹掉。`creditWatch()` 从读到写全程同步 (`await` 会重新打开丢更新窗口)，`loadLedger()` 带 `loaded` 守卫防止并发加载互相覆盖，`storage.onChanged` 用 `lastWritten` 认出自己的回声、不把账本倒回旧值。已经开着看到尾的标签页拿到 `inCooldown` 必须说 `over` 台词（用户没重新点开过任何东西）。「加载时额度已用完」这条路径不经过 `creditWatch()`，改发 `sm:limitShutdown` → 幂等的 `stampShutdown()` 补盖 `shutAt`，否则之后每次打开都说「时间到」而不是「还敢点开」。

  `limit.test.ts` 21 项；189 个测试通过。浏览器端到端：单标签 15/15（到点说话后关标签页、冷却期再开再关且不续期、暂停 6 秒花费 0ms、播放继续累计）；双标签 8/8（两个标签页累加进同一总额 20729ms、前台暂停时后台标签页不计费、触发说 `over` 不说 `back`、关页后 `shutAt` 只盖一次且 `usedMs` 归零）。

- 2026-10-24 修「请求参数不合法」：两个根因都在客户端请求体形状上。① `videoBucket()` 对直播（`Infinity`）、未加载（`NaN`）、无时长返回 `''`，而 `buildAnalyzeBody` 一直带这个键，服务端 `z.enum([...]).optional()` 不接受空串 → 这些视频的反应 100% 被 422 丢掉。改为空串时不发该键。② `dwellMs` 无上限，复聊累加后超出 schema 的 `max(900_000)`（默认 8s/60s 第 16 句、最大 120s/600s 第 3 句越界）→ 加 `MAX_DWELL_MS` 钳制。导出 `analyzeBodySchema`，`frames.test.ts` 用真实 schema 校验真实扩展产出；已验证回退修复后测试红（3 失败），修复后 168 个全绿。

- 2026-10-24 截图改造（A+B+D+prompt）：新增 `frames` 模块从 `<video>` 播放中取帧（不 seek），自适应间隔覆盖整个读秒窗口，`SecurityError` 时静默回退整屏；四格拼图带序号仍是一张图。回退路径先隐藏自家 overlay，修掉「模型从截图里读到自己上一句」的自我强化。时长只传 `videoBucket` 分桶（short/medium/long），`BUCKET_HINT` 定性描述，绝不传秒数。prompt 增加「几帧拼图，不要推断没看到的动作」。新增 `frames.test.ts` 10 项；164 个测试通过。
- 2026-10-24 去「时长」口头禅：根因是 `buildAnalyzeMessages()` 每轮把 `dwellMs` 以「停留了 8000 毫秒」写进 prompt，模型据此刻回「八秒」；另外旧规则「不要每轮提『八秒』」又在同一段 prompt 里复述目标词，形成自我强化。改法：user 文本固定为「用户停在这一条上」不再带数字，「看了更久」只由 `repeat` 表达；约束改成正向表述；清理 `zh.ts` 两处含时长词的措辞与 `MockProvider` maomao 池里的「八秒」；新增 `usedAngles()` 角度去重（命中才提示）。有意不做确定性删分句过滤。154 个测试通过。
- 2026-10-24 红点 / 广告 / 长视频复聊：删除悬浮球右上角未读红点（含 CSS、`badge` 元素与 `state.unread`）；`readAdLabel()` 只认可见的独立「广告」短标签，服务端 `isAdvertisement(result, confirmed)` 需模型标记与广告文案双信号一致，命中后 `reaction` 固定为 `adReaction()` 且客户端强切 `angry`；`repeatDwellSeconds` 新设置（默认 60s，0 = 不重复），`core.js` 新增 `dwellGoalMs()`，`tracker` 按 video key 记本次观看次数、刷走即清空（回来重新读秒），复聊请求带 `repeat: true` 且不增加 `videoCount`。146 个测试通过。
- 2026-10-24 表情配额：`pickChatColor()` 拆成 `matchChatColor()`（内容）+ `pickBalancedColor()`（配额）；补 `excited` 映射与「有点上头」触发词，补「嫌弃」的无语/离谱/服了；客户端 `emotionTally` 随请求上报、随会话持久化。实测 120 轮混合消息 9 种表情各 12–13 次。130 个测试通过。
- 2026-10-24 喵后缀 + 开机招呼：服务端 `withMaoSuffix()` 统一追加（chat 的 `flush()`、analyze 的 `reaction`、中性兜底）；客户端 `stripMaoTail()` 保证识别不受影响；prompt 禁止模型自写「喵」。开机招呼走本地 `OPENERS` 模板池 + 固定 `greet` 表情，已说句子持久化到 `smOpenerSeen`。114 个测试通过。
- 2026-10-24 新建对话：标题栏新增「新对话」→ `newSession()`（归档当前会话 + 重置 state）；历史列表包含当前会话并高亮；**排序改为按 `startedAt` 建立时间降序**（`core.js` 新增 `byStartedAtDesc()`），`describeSession()` 同步用建立时间；当前会话禁止「删除」；93 个测试通过。
- 2026-10-23 Claude Code 对接：重写本文件，新增 `/handoff-check`，更新 `/emotion-check` 与 `/chat-quality-check`；已验证 Claude Code `2.1.153`、VS Code 扩展 `anthropic.claude-code`，`claude -p` 能读取本文件。
- 2026-10-23 表情驱动修正：用户输入不再切；AI 回复完整结束后内容识别，失败用 `/v1/chat` 的 `done.emotion` 兜底；`persona.ts` / `zh.ts` 增加情绪立场和每轮底色；`emotions.js` 扩容；92 个测试通过。
- 2026-10-23 聊天质量 v3 / DeepSeek：`.env.local` 优先、mock 回退、401/403/400 映射、`voiceFilter`、DeepSeek 温度 0.92。
- 2026-10-23 会话记录 / 停留时长：`state.messages` 单一事实源、`smHistory`、`bubbleSeconds` / `emotionHoldSeconds`。
- 2026-10-24 气泡头像调大：`.msgava` 24px → 36px（24px 下嫌弃和生气几乎分不出来），fallback 图标同步 16px → 24px，行 `max-width` 92% → 96% 抵消头像占宽，`gap` 7px → 8px；去掉了原先 `margin-top:1px` 的微调（气泡上内边距 8px + 首行高约 20px，首行中心正好在 18px，也是 36px 头像的中心，顶部对齐即居中）。浏览器实测 5 行消息头像均为 36px，用户消息仍不带头像。
- 2026-10-24 面板头像 + 去副标题：删掉面板标题下的「刷视频成瘾，说话直」小字（`popup.html` 里的同名副标题保留）。新增 §2.2.2：每条 assistant 消息左侧 24px 圆形头像，取该消息自己的表情立绘；`.msg.a` 改成 flex 行 + `.col` 气泡，用户消息不带头像；`message.emotion` 随会话持久化（`normalizeMessage()` 只认 `EMOTION_IDS`，只对 assistant 生效），老存档回退到按正文 `detect()`。`appendReaction` / `appendOpening` / `startStream` / `finishStream` 都写入表情，`onDwell` 把 `vibe.id` 传进日志，所以 `isAd`、`fromMood` 这类文字推不出的路径也能对上。顺带修掉 `headAvatar()` 里的 `EMOTIONS_DEFAULT` 笔误（应为 `EMOTION_DEFAULT`，它让 `mount()` 抛错、整个面板打不开），并把 `tools/make-icons.mjs` 从画线稿猫改成从 `greet-128.png` 派生（否则重跑会把新图标盖回旧图）。166 个测试通过。
- 2026-10-24 改名 + 换图标：「刷子喵喵」→「喵喵陪你刷」，同步 `manifest.json`（name / description / default_title）、`popup.html` 标题与 `<h1>`、`buddy.js` 的面板标题与 aria/title、`persona.ts` 的 `label` 与人设首句。`voiceFilter.ts` 的说话人前缀正则同时保留旧名（模型偶发自标「刷子喵喵：」仍要剥掉），并补一条测试。工具栏 `icons/icon{16,48,128}.png` 由 `assets/emotions/greet-128.png`（默认态立绘）用面积平均 + 透明度加权缩放重新生成（`popup.html` 的头部头像也换成立绘）。165 个测试通过。
- 2026-10-24 清理：删除 `.backup-emotion-20261023-183631`、`.backup-chat-20261023-200141`、`server/dist/`（可 `npm run build` 重建）、`extension/icons/*.svg`（manifest 只引用 PNG）；修掉 `frames.test.ts` 的 flaky 断言（原来对整个序列化 body 搜 "15"，会被随机 `requestId` 命中）。
- 备份：无（`.backup-*` 已于 2026-10-24 清理）。
