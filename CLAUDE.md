# video-buddy · Claude Code 项目说明

> 最后更新：2026-10-24
> 项目：抖音网页悬浮球「上头了喵喵」聊天插件
> 技术栈：Chrome Manifest V3 + 原生 JS；Node 22 + Fastify + TypeScript；DeepSeek OpenAI-compatible
> 交接状态：功能可运行，自动化测试通过（198 个）；红点移除 / 广告识别 / 长视频复聊三项真实抖音页面回归已由用户确认（2026-10-24）。**刷视频限时（§2.1.7）与键盘守卫只做过 headless 浏览器验证，真实抖音页面回归待做**——见 §4.4。改动前先读本文件，改动后跑第 4.4 节验收。
> 给 Claude Code：先读第 2.2 节（表情链路）和第 6 节（对接/守则）；开始改代码前先执行 `/handoff-check`。

## 1. 项目结构

- `extension/`
  - `manifest.json` — MV3；**两条** content scripts 条目：`shared/keyboard-guard.js`（`document_start`，键盘隔离）在前，`shared/core.js` → `shared/emotions.js` → `content/buddy.js`（`document_idle`）在后。第 2 条内部顺序不可改
  - `content/buddy.js` — 悬浮球、停留计时、聊天面板、SSE 流、表情切换、刷视频限时（`limiter`）
  - `shared/keyboard-guard.js` — `document_start` 安装 window 捕获阶段键盘守卫；面板输入框里的 Enter/Escape 通过 `window.__smKeyboardGuard.setHandlers()` 回调给 `buddy.js`
  - `shared/core.js` — 设置、请求体、SSE parser、历史记录、限时额度状态机
  - `shared/emotions.js` — 9 情绪、别名、关键词/语气识别、图标路径
  - `background.js` — 唯一访问本地服务的 service worker；代理 SSE，转发 `done.emotion`
  - `popup/` — 设置页（服务地址、令牌、停留/复聊间隔/气泡/图标时长等）
  - `assets/emotions/{id}-128.png` — 9 个运行时图标
  - `icons/icon{16,48,128}.png` — 工具栏图标，由 `assets/emotions/greet-128.png`（默认态立绘）缩放生成；换角色时同步重生成
  - `tools/e2e.mjs` — 扩展 e2e harness（可选）
  - `tools/pack-extension.mjs` — 公开分发打包脚本；**白名单**产出 ZIP，见 §4.5
- `server/`
  - `src/index.ts` — Fastify 启动
  - `src/routes/chat.ts` — `/v1/chat` SSE
  - `src/routes/analyze.ts` — `/v1/analyze`
  - `src/prompts/persona.ts` — 人设
  - `src/prompts/zh.ts` — system prompt、视频锚点、每轮情绪底色、`pickChatEmotion()`
  - `src/providers/` — `DeepSeekProvider` / `MockProvider`
  - `src/safety/voiceFilter.ts` — 流式过滤感叹号、哈哈等
  - `test/` — Vitest
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

### 2.1.7 刷视频限时（每日额度 + 关页）

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
9. 设置项在 popup 的「刷视频限时」：`limitEnabled`（**全新安装默认 `false`**，见 §2.1.8）/ `limitMinutes`（1–600，默认 30）/ `limitCooldownMinutes`（0–720，默认 10，0 = 只关一次）/ `limitCloseSeconds`（0–30，默认 5）。
10. `limitEnabled` 关闭时 `limitBudgetMs()` 返回 0，`limitSnapshot()` 直接 `disabled`，不读也不写额度。

### 2.1.8 设置迁移与全新安装默认值

1. **`limitEnabled` 默认 `false`**（面向公开分发）。陌生人装完半小时后被自动关标签页，差评和商店审核解释成本都不划算。
2. **旧配置不能被这条默认值误伤**：凡是「限时功能上线前保存过设置」的机器，存储里根本没有 `limitEnabled` 这个键，直接落到新默认值就会**静默关掉用户已经在用的功能**。`core.js` 的 `legacyLimitEnabled(source)` 判断：**有别的键但没有 `limitEnabled`** → 视为旧配置，保留 `true`；**空对象** → 全新安装，用新默认值。显式写入的值（`true` / `false`）永远优先。
3. 这个判断放在 `normalizeSettings()` 内部，不新增需要各处调用的迁移函数：`normalizeSettings` 是 popup / background / content 的**唯一汇合点**，多一个入口就多一处可能被漏调。
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
```

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
| `limitCooldownMinutes` | 0–720，默认 10 | 同上。0 = 只关一次 |
| `limitCloseSeconds` | 0–30，默认 5 | 纯本地。旧 core 允许 60 而 popup 只到 30，手改配置会得到 UI 无法撤回的行为 |
| `ballSize` | 40–96，默认 60 | 1–2 个抖音头像大小 |

`DEFAULTS` 里每个值都必须落在自己的区间内，否则 `normalizeSettings()` 会静默改掉默认值，popup 显示的和实际生效的就对不上（这条也有测试守着）。

### 4.3 运行与健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

期望看到 `provider: "deepseek"`、`configuredProvider: "deepseek"`、`providerFallback: false`。如果返回 mock，先看 `server/.env.local` 是否被加载，不要改 `server/.env`。

### 4.4 验收清单

改完代码至少确认：

- `npm.cmd test` 全部通过（当前 198 个，以实际输出为准）
- `npm.cmd run typecheck` 退出码 0
- `npm.cmd run build` 退出码 0
- 四个扩展 JS 的 `node --check` 退出码 0
- `/health` 的 provider 符合预期
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
- 人工回归（限时）：把「每日时长」设成 1 分钟、「再打开时」设成 2 分钟，刷视频约 1 分钟后气泡说话且图标变 `angry`，5 秒后标签页自动关闭；2 分钟内重新打开抖音，它说另一句、5 秒后再关一次（点开就被关，不等 1 分钟）；等过 2 分钟再打开，恢复正常且重新给满 1 分钟。暂停视频挂机 5 分钟不应触发
- 人工回归（限时·切后台）：停在抖音但切到别的标签页放 5 分钟，回来不应触发限时（只算前台播放时间）
- 人工回归（限时·多标签页）：开两个抖音标签页各刷一段，看 `chrome.storage.local` 的 `smLimit.usedMs` 应是一条累计总额而不是两次独立计数；两个标签页加起来到点只关当前在看的那个，另一个继续开着的也不该说「还敢点开」
- 人工回归（键盘）：面板输入框里打字，抖音的快捷键（`J` / `K` / 空格等）不应被触发；Enter 正常发消息、Shift+Enter 换行、Escape 关面板

### 4.5 公开分发打包

```powershell
node extension/tools/pack-extension.mjs
# 产出 releases/shangtou-miaomiao-v<version>.zip
```

1. **白名单打包，不是排除法**。文件清单从 `manifest.json` 反推（content scripts / service worker / popup / icons / `web_accessible_resources`），所以新增文件默认**不进包**，要显式加。排除法会失败开放：漏一条规则就发出一个密钥。
2. **`extension/tools/` 不进包**（里面有 47KB e2e harness 和图标生成脚本）。脚本会拒绝任何 `tools/`、`test/`、`.backup-` 前缀以及 `.pem` / `.env*` 条目。
3. ZIP 条目名一律正斜杠。Windows 上 `path.join()` 产出反斜杠，严格读取器会把 `popup\popup.js` 当成一个文件名。
4. 发布前必须确认解压后**不含** `extension.pem`、`server/`、`.env*`。`extension.pem` 在仓库根目录，永远不要从仓库根执行打包或部署类命令。
5. 版本号改 `manifest.json` 的 `version`，ZIP 文件名自动跟随。

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
- 不引入扩展构建步骤或框架；扩展是原生 JS。
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

## 8. 变更记录（压缩）

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
- 2026-10-24 改名 + 换图标：「刷子喵喵」→「上头了喵喵」，同步 `manifest.json`（name / description / default_title）、`popup.html` 标题与 `<h1>`、`buddy.js` 的面板标题与 aria/title、`persona.ts` 的 `label` 与人设首句。`voiceFilter.ts` 的说话人前缀正则同时保留旧名（模型偶发自标「刷子喵喵：」仍要剥掉），并补一条测试。工具栏 `icons/icon{16,48,128}.png` 由 `assets/emotions/greet-128.png`（默认态立绘）用面积平均 + 透明度加权缩放重新生成（`popup.html` 的头部头像也换成立绘）。165 个测试通过。
- 2026-10-24 清理：删除 `.backup-emotion-20261023-183631`、`.backup-chat-20261023-200141`、`server/dist/`（可 `npm run build` 重建）、`extension/icons/*.svg`（manifest 只引用 PNG）；修掉 `frames.test.ts` 的 flaky 断言（原来对整个序列化 body 搜 "15"，会被随机 `requestId` 命中）。
- 备份：无（`.backup-*` 已于 2026-10-24 清理）。
