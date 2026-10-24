import { describe, expect, it } from 'vitest';
import { adReaction, finalizeAnalyzeResult, isAdvertisement } from '../src/safety/guards.js';
import type { AnalyzeResult } from '../src/types.js';

const base: AnalyzeResult = {
  summary: '猫在拆家',
  keywords: ['猫'],
  mood: '搞笑',
  isAd: false,
  isLive: false,
  risk: 'ok',
  reaction: '这猫是真把自己当主子了',
  memeUsed: null,
  confidence: 0.8,
};

/** A video that merely mentions 广告 in passing must not be reclassified. */
const mentionsAd: AnalyzeResult = {
  ...base,
  summary: '博主吐槽最近广告太多',
  keywords: ['吐槽'],
  reaction: '这条吐槽有点东西',
};

/** Copy that reads like an ad, but the model never flagged it. */
const adCopy: AnalyzeResult = {
  ...base,
  summary: '品牌合作款口红，下单立减',
  keywords: ['口红'],
  reaction: '这口红看着还行',
};

describe('isAdvertisement', () => {
  it('needs both the model flag and a concrete ad marker', () => {
    expect(isAdvertisement({ ...base, isAd: true })).toBe(false);
    expect(isAdvertisement(adCopy)).toBe(false);
    expect(isAdvertisement(mentionsAd)).toBe(false);
  });

  it('accepts a result carrying both signals', () => {
    expect(isAdvertisement({ ...adCopy, isAd: true })).toBe(true);
    expect(isAdvertisement({ ...base, isAd: true, summary: '小黄车挂了三件' })).toBe(true);
  });

  it('accepts a page-confirmed label with no model involvement', () => {
    // The 「广告」 chip on the page is first-hand evidence, not an inference.
    expect(isAdvertisement(base, true)).toBe(true);
    expect(isAdvertisement({ ...base, isAd: false, summary: '' }, true)).toBe(true);
  });

  it('does not treat ordinary marketing-adjacent words as markers', () => {
    // 商品 / 品牌 / 推荐 show up in normal videos constantly.
    const ordinary: AnalyzeResult = {
      ...base,
      isAd: true,
      summary: '这个品牌的商品都挺好看',
      keywords: ['品牌', '推荐'],
      reaction: '推荐你先看第二条',
    };
    expect(isAdvertisement(ordinary)).toBe(false);
  });
});

describe('ad reactions', () => {
  it('gives every tone a line that reads as annoyed', () => {
    for (const tone of ['maomao', 'roaster', 'cheerleader', 'professor'] as const) {
      const line = adReaction(tone);
      expect(line.length).toBeGreaterThan(0);
      expect(/广告|气人|过分/.test(line)).toBe(true);
    }
  });

  it('replaces whatever the model wrote with the fixed line', () => {
    const ad: AnalyzeResult = { ...adCopy, isAd: true, reaction: '姐妹们冲，真的好用' };
    const result = finalizeAnalyzeResult(ad, [], [], 'maomao');
    expect(result.isAd).toBe(true);
    expect(result.reaction).toBe('又塞广告，太过分了喵');
    expect(result.memeUsed).toBeNull();
  });

  it('overrides the confidence fallback instead of stacking on it', () => {
    // A low-confidence ad must not fall through to the neutral line.
    const ad: AnalyzeResult = { ...adCopy, isAd: true, confidence: 0.1 };
    const result = finalizeAnalyzeResult(ad, [], [], 'maomao');
    expect(result.reaction).toBe('又塞广告，太过分了喵');
  });

  it('honours a page-confirmed label even when the model disagrees', () => {
    const result = finalizeAnalyzeResult(base, [], [], 'maomao', true);
    expect(result.isAd).toBe(true);
    expect(result.reaction).toBe('又塞广告，太过分了喵');
  });

  it('leaves a flagged-but-unconfirmed non-ad alone', () => {
    // The model said "ad"; nothing corroborates it. Keep the real reaction.
    const result = finalizeAnalyzeResult({ ...base, isAd: true }, [], [], 'maomao');
    expect(result.isAd).toBe(false);
    expect(result.reaction).toBe('这猫是真把自己当主子了喵');
  });

  it('keeps the ad path behind the blocked-term check', () => {
    const dirty: AnalyzeResult = { ...adCopy, isAd: true, summary: '地震现场广告' };
    const result = finalizeAnalyzeResult(dirty, [], [], 'maomao');
    expect(result.risk).toBe('blocked');
    expect(result.reaction).toBe('');
  });

  it('carries an emotion marker the client can detect', () => {
    // Client-side `Emotions.detect` reads 过分/气人; the forced `angry` avatar
    // depends on this, so the wording is a contract.
    for (const tone of ['maomao', 'cheerleader', 'professor'] as const) {
      expect(/过分|气人/.test(adReaction(tone))).toBe(true);
    }
    expect(/广告/.test(adReaction('roaster'))).toBe(true);
  });
});
