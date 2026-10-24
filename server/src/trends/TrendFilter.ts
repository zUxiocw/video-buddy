import type { TrendItem } from '../types.js';
import { bigrams, clampText, overlapCount } from '../lib/text.js';
import { isSafeTrendWord } from '../safety/guards.js';

export interface RankedTrend {
  word: string;
  overlap: number;
  rank: number;
}

export function filterSafeTrends(items: readonly TrendItem[]): TrendItem[] {
  const seen = new Set<string>();
  const out: TrendItem[] = [];
  for (const item of items) {
    const word = clampText(item.word, 40);
    if (!isSafeTrendWord(word)) continue;
    const key = word.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      word,
      ...(Number.isFinite(item.hotValue) ? { hotValue: item.hotValue } : {}),
    });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Only inject trends that share at least one character bigram with the
 * current caption/OCR. This keeps the model from shoehorning unrelated news.
 */
export function selectTrendCandidates(
  items: readonly TrendItem[],
  contextText: string,
  max = 3,
): string[] {
  const context = clampText(contextText, 2000);
  if (!context) return [];
  const contextGrams = bigrams(context);
  if (contextGrams.size === 0) return [];

  const ranked: RankedTrend[] = [];
  items.forEach((item, rank) => {
    if (!isSafeTrendWord(item.word)) return;
    const overlap = overlapCount(contextGrams, bigrams(item.word));
    if (overlap < 1) return;
    ranked.push({ word: clampText(item.word, 40), overlap, rank });
  });

  ranked.sort((a, b) => b.overlap - a.overlap || a.rank - b.rank);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of ranked) {
    const key = candidate.word.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate.word);
    if (out.length >= max) break;
  }
  return out;
}
