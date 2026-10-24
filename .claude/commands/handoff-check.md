---
description: 交接前完整验收：测试、类型、构建、扩展语法和表情链路
---

读取 `CLAUDE.md`，按顺序执行完整验收。默认只检查、不改文件；有失败项时给出最小修复建议。

## 1. 静态不变量

确认：

- `extension/manifest.json` content scripts 顺序是 `shared/core.js` → `shared/emotions.js` → `content/buddy.js`
- `extension/assets/emotions/` 有 9 个 `*-128.png`
- `extension/content/buddy.js` 的 `sendMessage()` 不调用 `Emotions.detect` / `ui.setEmotion`
- `finishStream()` 先识别 `reply.content`，没有结果才用 `serverEmotion`，最后 `setEmotion(..., source: 'assistant')`
- `extension/background.js` 转发 `done.emotion`
- `server/src/routes/chat.ts` 的 `done` 帧带 `emotion`
- `server/src/prompts/zh.ts` 有 `pickChatEmotion()` 和「这一轮的情绪底色」

## 2. 扩展语法

```powershell
node --check extension/content/buddy.js
node --check extension/background.js
node --check extension/shared/emotions.js
node --check extension/shared/core.js
```

## 3. 服务端

```powershell
npm.cmd --prefix server test
npm.cmd --prefix server run typecheck
npm.cmd --prefix server run build
```

记录实际测试数量；不要只写「通过」。

## 4. 运行中的服务（可选）

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

期望 `provider` 为 `deepseek`、`configuredProvider` 为 `deepseek`、`providerFallback` 为 `false`。如果服务没启动，标记「未运行」，不算失败。

## 5. 输出

给出一份交接摘要：

- 结论：可交接 / 有阻塞
- 测试数量、typecheck、build 结果
- 失败项与文件 / 函数
- 3 条人工回归步骤（发送时不切、回复结束才切、中性回复用 hint 兜底）
- 不要自动修复，除非用户明确说「按报告修」
