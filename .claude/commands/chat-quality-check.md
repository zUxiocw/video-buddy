---
description: 检查聊天去重、视频贴合、活人感和情绪底色
---

读取 `CLAUDE.md`，只做检查，不要修改文件。

逐项输出「通过 / 失败」：

## 1. persona

检查 `server/src/prompts/persona.ts`：

- maomao 人设是否包含：直白朋友、简洁、不重复、不说教、不说「抱歉 / 我不能」、少量粗口、自然
- 是否仍保留猫娘身份和「不是主仆」
- 是否有「每轮都要有明确情绪立场，别做中性总结」
- 是否要求情绪从判断、吐槽或关心里漏出来，而不是直接报情绪名

## 2. prompt

检查 `server/src/prompts/zh.ts`：

- 聊天 system 是否包含「本视频可用的具体锚点」
- 是否包含「最近你已经说过的」
- 是否包含「这一轮只做这个表达动作」
- 是否有套话黑名单（确实 / 说实话 / 这波 / 有点东西 / 你懂的）
- analyze reaction 是否有「不要复用最近反应」「只挑一个具体细节」
- 是否有 `pickChatColor()`、`pickChatEmotion()`、`COLOR_TO_EMOTION`
- `COLOR_TO_EMOTION` 是否覆盖：`嫌弃` / `被逗乐` / `好奇` / `关心` / `不耐烦` / `震惊` / `有点得意` / `心疼` / `炸毛`
- 是否按语境映射：难过 → 心疼，低落 → 关心，笑 → 被逗乐，问候 → 关心，生气 → 炸毛，震惊 → 震惊，提问 → 好奇，推荐 → 嫌弃，道谢 → 有点得意
- prompt 是否包含「这一轮的情绪底色」
- `pickChatEmotion()` 是否只对 `tone === 'maomao'` 生效

## 3. MockProvider

检查 `server/src/providers/MockProvider.ts`：

- 是否有多个意图分支（问候 / 问视频 / 问原因 / 推荐 / 玩梗 / 笑 / 低落 / 道谢 / 问号 / 通用）
- 是否使用 `pickFresh()` 去重
- seed 是否包含 `requestId`、`sessionId`、`history`
- 输出是否经过 `applyMaomaoStyle()`
- `isLowMood()` 是否覆盖「今天好烦」「最近很累」等表达，且不误伤「这视频拍得挺累人的」

## 4. provider 参数

检查 `server/src/providers/DeepSeekProvider.ts`：

- 聊天 temperature 是否约 0.92
- max_tokens 是否约 220，避免长篇跑题

## 5. SSE 情绪提示

检查 `server/src/routes/chat.ts`：

- 是否在请求开始时计算 `emotionHint = pickChatEmotion(input)`
- `done` 帧是否按条件包含 `emotion`
- `emotion` 值必须是 9 个合法 id 之一，不能是中文底色名

## 6. 运行

```powershell
npm.cmd --prefix server test
npm.cmd --prefix server run typecheck
npm.cmd --prefix server run build
```

## 7. 采样

用 MockProvider 采样 8 条不同 requestId 的「这视频讲了啥」，确认：

- 不出现感叹号、哈哈、呵
- 至少出现 3 种不同回复
- 每条都包含当前视频摘要中的具体信息（如「猫在拆家」）
- 对 maomao，`pickChatEmotion()` 返回合法 id 或 `null`；对非 maomao，返回 `null`

## 8. 报告

输出通过项、失败项、最小修复建议。默认不要改文件。
