---
description: 检查 AI 回复驱动的 9 情绪切换链路
---

读取 `CLAUDE.md`，只做检查，不要修改文件。

核心不变量：

- 用户发送消息不得切表情。
- 只有助手完整回复结束后才切。
- 正文识别优先；正文没有情绪词时才用服务端 `done.emotion` 兜底。

逐项输出「通过 / 失败」：

## 1. manifest 与资源

- `extension/manifest.json` 的 content scripts 顺序是否为 `shared/core.js` → `shared/emotions.js` → `content/buddy.js`
- `web_accessible_resources` 是否包含 `assets/emotions/*.png`
- `extension/assets/emotions/` 是否有 9 个 `*-128.png`

## 2. emotions.js

- 是否有 9 个 id：`sad` / `happy` / `annoyed` / `angry` / `laugh` / `excited` / `greet` / `confused` / `shocked`
- `get()` 是否支持中文标签与英文别名
- `detect()`、`fromMood()`、`iconPath()` 是否存在
- 用 Node 验证（期望输出 `annoyed laugh annoyed`）：

```powershell
node -e "const E=require('./extension/shared/emotions.js'); console.log(E.detect('别找原因，就是饵')?.id, E.detect('笑死')?.id, E.fromMood('无语')?.id)"
```

## 3. 用户输入不触发

检查 `extension/content/buddy.js` 的 `sendMessage()` 函数体：

- 是否只做清洗文本、`pushMessage('user', text)`、`startStream(text)`
- 函数体内是否**没有** `Emotions.detect(...)` / `ui.setEmotion(...)`
- 全文件搜索 `setEmotion`，确认调用点只有：`onDwell()`、`finishStream()`、默认重置、对外导出

## 4. 助手回复驱动

检查 `extension/content/buddy.js`：

- `startStream()` 的 `done` 分支是否调用 `finishStream(reply, message.emotion)`
- `finishStream()` 是否按顺序：
  1. `var replyVibe = Emotions.detect(reply.content);`
  2. 如果为空且 `serverEmotion` 存在：`replyVibe = Emotions.get(serverEmotion);`
  3. 最后 `ui.setEmotion(replyVibe.id, { force: true, source: 'assistant' })`
- 是否存在“用户消息发出后立刻切表情”的代码路径

检查 `extension/background.js`：

- `done` 事件是否解析 `data.emotion`（只接受 string）
- 是否转发 `{ type: 'done', emotion: doneEmotion }`

## 5. 服务端提示

检查 `server/src/prompts/zh.ts`：

- 是否有 `COLOR_TO_EMOTION`，覆盖 9 种底色
- 是否导出 `pickChatEmotion(input)`
- prompt 是否包含「这一轮的情绪底色」
- 是否只在 `tone === 'maomao'` 时返回情绪

检查 `server/src/routes/chat.ts`：

- 是否计算 `emotionHint = pickChatEmotion(input)`
- SSE `done` 帧是否按条件带 `emotion` 字段

## 6. 运行

```powershell
node --check extension/content/buddy.js
node --check extension/background.js
node --check extension/shared/emotions.js
npm.cmd --prefix server test
npm.cmd --prefix server run typecheck
```

## 7. 报告

输出：

- 通过项
- 失败项与具体文件 / 函数
- 是否存在“用户输入触发”的回归（这是最高优先级）
- 建议的最小修复（不要直接改文件）

默认只检查，不改文件。
