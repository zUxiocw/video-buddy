import { describe, expect, it } from 'vitest';
import { buildAnalyzeMessages, buildChatMessages, usedAngles } from '../src/prompts/zh.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import type { AnalyzeInput, ChatInput } from '../src/types.js';

/** Anything that reads as "how long the user watched". */
const DURATION = /\d+\s*(秒|分钟|小时)|[一二三四五六七八九十两几]\s*(秒|分钟|小时)|毫秒/;

const analyzeInput: AnalyzeInput = {
  requestId: 'dur-analyze',
  app: 'douyin',
  tone: 'maomao',
  dwellMs: 8000,
  ocr: { text: '猫在拆家', caption: '猫主子又拆家了', hashtags: ['萌宠'] },
  images: [],
  recentReactions: [],
  trendCandidates: [],
  slangCandidates: [],
};

const chatInput: ChatInput = {
  requestId: 'dur-chat',
  sessionId: 'dur-session',
  tone: 'maomao',
  message: '这猫怎么又拆家',
  context: { summary: '猫在拆家', keywords: ['猫'], caption: '猫主子又拆家了' },
  history: [],
  trendCandidates: [],
  slangCandidates: [],
  privacyTextOnly: true,
};

/** Flatten both plain-string messages and multimodal text parts. */
function promptText(messages: ReturnType<typeof buildAnalyzeMessages>): string {
  return messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
    )
    .join('\n');
}

describe('no dwell time in any prompt', () => {
  it('never prints dwellMs to the model', () => {
    // 8000 was the old tell: the model read it and answered 「八秒」.
    for (const dwellMs of [8000, 1500, 61_000, 0]) {
      const text = promptText(buildAnalyzeMessages({ ...analyzeInput, dwellMs }, 'low'));
      expect(text, `dwellMs=${dwellMs}`).not.toMatch(DURATION);
    }
  });

  it('keeps the "seen longer" signal without a number', () => {
    const first = promptText(buildAnalyzeMessages(analyzeInput, 'low'));
    const again = promptText(buildAnalyzeMessages({ ...analyzeInput, repeat: true }, 'low'));
    expect(first).not.toContain('第二眼');
    expect(again).toContain('第二眼');
    expect(again).not.toMatch(DURATION);
  });

  it('does not name the forbidden word in its own rule', () => {
    // The old rule listed 「八秒/刷视频/上瘾」, re-seeding the word every turn.
    const analyze = promptText(buildAnalyzeMessages(analyzeInput, 'low'));
    const chat = promptText(buildChatMessages(chatInput));
    for (const text of [analyze, chat]) {
      expect(text).not.toContain('八秒');
      expect(text).not.toContain('停了几秒');
      expect(text).not.toMatch(DURATION);
    }
  });

  it('tells the model not to bring up duration at all', () => {
    const analyze = promptText(buildAnalyzeMessages(analyzeInput, 'low'));
    expect(analyze).toContain('不要提任何时长');
  });
});

describe('mock reactions avoid duration talk', () => {
  it('has no duration in any maomao template', async () => {
    const provider = new MockProvider();
    // Sweep keyword sets so every pool entry gets a chance to be chosen.
    const seen = new Set<string>();
    for (const word of ['猫', '狗', '翻车', '剧情', '比赛', '美食', '旅行', '手工']) {
      for (const mood of ['搞笑', '治愈', '无语', '种草', '感动', '燃', '其他']) {
        const result = await provider.analyze(
          {
            ...analyzeInput,
            requestId: `dur-mock-${word}-${mood}`,
            ocr: { text: `${word} ${mood}`, caption: `${word}${mood}`, hashtags: [] },
            recentReactions: [...seen],
          },
          new AbortController().signal,
        );
        const reply = result.reaction;
        expect(reply, `keyword=${word} mood=${mood}`).not.toMatch(DURATION);
        if (reply) seen.add(reply);
      }
    }
  });
});

describe('usedAngles', () => {
  it('reports only the angles that actually appear', () => {
    expect(usedAngles([])).toEqual([]);
    expect(usedAngles(['这猫看八秒'])).toEqual(['停留时长']);
    expect(usedAngles(['评论区比正片有戏'])).toEqual(['评论区']);
    expect(usedAngles(['这猫看八秒', '评论区比正片有戏'])).toEqual(['停留时长', '评论区']);
    expect(usedAngles(['这猫的表情很到位'])).toEqual([]);
  });

  it('does not count an empty or blank history', () => {
    expect(usedAngles(['', '   '])).toEqual([]);
  });
});
