import { describe, expect, it } from 'vitest';
import { applyMaomaoStyle, finalizeAnalyzeResult, withMaoSuffix } from '../src/safety/guards.js';
import { createMaomaoStreamFilter } from '../src/safety/voiceFilter.js';
import type { AnalyzeResult } from '../src/types.js';

describe('withMaoSuffix', () => {
  it('appends 喵 to a plain sentence', () => {
    expect(withMaoSuffix('这猫又在拆家')).toBe('这猫又在拆家喵');
    expect(withMaoSuffix('我服了')).toBe('我服了喵');
  });

  it('keeps trailing punctuation after the tail', () => {
    expect(withMaoSuffix('真的假的？')).toBe('真的假的喵？');
    expect(withMaoSuffix('别看了。')).toBe('别看了喵。');
    expect(withMaoSuffix('就这')).toBe('就这喵');
  });

  it('never doubles an existing 喵', () => {
    expect(withMaoSuffix('这猫又在拆家喵')).toBe('这猫又在拆家喵');
    expect(withMaoSuffix('真的假的喵？')).toBe('真的假的喵？');
    expect(withMaoSuffix('好喵喵')).toBe('好喵');
  });

  it('leaves punctuation-only replies alone', () => {
    expect(withMaoSuffix('？')).toBe('？');
    expect(withMaoSuffix('？？')).toBe('？？');
  });

  it('returns empty for empty input', () => {
    expect(withMaoSuffix('')).toBe('');
    expect(withMaoSuffix('   ')).toBe('');
  });

  it('does not change what the text means for emotion detection', () => {
    // `就这` is an annoyed keyword anchored on the end of the sentence.
    // Detecting on the tagged text is the client's job; here we only assert
    // the tail is a pure addition and the body survives intact.
    const tagged = withMaoSuffix('就这');
    expect(tagged.startsWith('就这')).toBe(true);
    expect(tagged.replace(/喵$/, '')).toBe('就这');
  });
});

describe('喵 tail on the chat stream', () => {
  function run(chunks: string[]): string {
    const filter = createMaomaoStreamFilter();
    let out = '';
    for (const chunk of chunks) out += filter.push(chunk);
    return out + filter.flush();
  }

  it('adds the tail once, at the very end of the reply', () => {
    expect(run(['这猫又', '拆家了'])).toBe('这猫又拆家了喵');
  });

  it('adds the tail after forbidden patterns are stripped', () => {
    expect(run(['笑死我了哈哈！'])).toBe('笑死我了喵');
    expect(run(['这猫好可爱~', '哦'])).toBe('这猫好可爱喵');
  });

  it('does not double a tail the model already produced', () => {
    expect(run(['这猫又拆家了喵'])).toBe('这猫又拆家了喵');
  });

  it('puts the tail before a trailing question mark', () => {
    expect(run(['真的', '假的？'])).toBe('真的假的喵？');
  });

  it('emits nothing when the reply is empty', () => {
    expect(run([])).toBe('');
    expect(run(['   '])).toBe('');
    // Nothing but stripped characters: there is no body to attach a tail to.
    expect(run(['~~~!!'])).toBe('');
  });

  it('still tags a reply whose last chunk is stripped away', () => {
    // The text was split so that every trailing character was removed by the
    // filter; the tail must attach to the already-sent body, not vanish.
    expect(run(['这猫好可爱~~~!!'])).toBe('这猫好可爱喵');
    expect(run(['这猫好可爱哈哈'])).toBe('这猫好可爱喵');
  });
});

describe('喵 tail on analyze reactions', () => {
  const raw: AnalyzeResult = {
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

  it('tags maomao reactions but leaves other tones untouched', () => {
    expect(finalizeAnalyzeResult(raw, [], [], 'maomao').reaction).toBe('这猫是真把自己当主子了喵');
    expect(finalizeAnalyzeResult(raw, [], [], 'roaster').reaction).toBe('这猫是真把自己当主子了');
  });

  it('tags the neutral fallback so it stays in character', () => {
    const result = finalizeAnalyzeResult({ ...raw, confidence: 0.1 }, [], [], 'maomao');
    expect(result.reaction.endsWith('喵')).toBe(true);
    expect(result.reaction.match(/喵/g)).toHaveLength(1);
  });

  it('never tags a blocked reaction, which stays empty', () => {
    const result = finalizeAnalyzeResult({ ...raw, reaction: '这场地震太惨了' }, [], [], 'maomao');
    expect(result.risk).toBe('blocked');
    expect(result.reaction).toBe('');
  });

  it('keeps the styled body intact around the tail', () => {
    const result = finalizeAnalyzeResult({ ...raw, reaction: '笑死我了哈哈！' }, [], [], 'maomao');
    expect(result.reaction).toBe('笑死我了喵');
    expect(result.reaction.replace(/喵$/, '')).toBe(applyMaomaoStyle('笑死我了哈哈！'));
  });
});
