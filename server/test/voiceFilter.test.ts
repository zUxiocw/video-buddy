import { describe, expect, it } from 'vitest';
import { createMaomaoStreamFilter } from '../src/safety/voiceFilter.js';

function run(chunks: string[]): string {
  const filter = createMaomaoStreamFilter();
  let out = '';
  for (const chunk of chunks) out += filter.push(chunk);
  return out + filter.flush();
}

describe('maomao stream filter', () => {
  it('removes forbidden punctuation split across deltas', () => {
    expect(run(['笑死我了哈', '哈！'])).toBe('笑死我了喵');
    expect(run(['你不', '是', '吧？！'])).toBe('你不是吧喵？');
    expect(run(['真的', '！'])).toBe('真的喵');
  });

  it('strips tildes, 语气词 and markdown emphasis', () => {
    expect(run(['这猫好可爱~', '哦'])).toBe('这猫好可爱喵');
    expect(run(['**别看了**'])).toBe('别看了喵');
  });

  it('keeps a lone question mark intact', () => {
    expect(run(['？'])).toBe('？');
    expect(run(['？', '？'])).toBe('？？');
  });

  it('drops a leading speaker label', () => {
    expect(run(['喵喵陪你刷：', '这猫又拆家了'])).toBe('这猫又拆家了喵');
  });

  it('also drops the previous names, which models still occasionally emit', () => {
    expect(run(['刷子喵喵：', '这猫又拆家了'])).toBe('这猫又拆家了喵');
    expect(run(['上头了喵喵：', '这猫又拆家了'])).toBe('这猫又拆家了喵');
  });

  it('emits nothing until enough context has accumulated', () => {
    const filter = createMaomaoStreamFilter();
    expect(filter.push('在')).toBe('');
    expect(filter.push('的')).toBe('');
    const rest = filter.flush();
    expect(rest).toBe('在的喵');
  });
});
