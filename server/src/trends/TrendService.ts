import type { SlangEntry } from '../types.js';
import { clampText } from '../lib/text.js';
import type { TrendSource } from './TrendSource.js';
import type { SlangLexicon } from './SlangLexicon.js';
import { selectTrendCandidates } from './TrendFilter.js';

export interface TrendCandidates {
  trends: string[];
  slang: SlangEntry[];
}

export class TrendService {
  constructor(
    private readonly source: TrendSource,
    private readonly lexicon: SlangLexicon,
    private readonly maxTrends = 3,
    private readonly maxSlang = 3,
  ) {}

  async getCandidates(
    contextText: string,
    keywords: string[] = [],
    options: { maxTrends?: number; maxSlang?: number } = {},
  ): Promise<TrendCandidates> {
    const text = clampText(contextText, 2000);
    let trends: string[] = [];
    try {
      const items = await this.source.getTrends();
      trends = selectTrendCandidates(items, text, options.maxTrends ?? this.maxTrends);
    } catch {
      // Trend injection is optional; never fail an analysis because of it.
      trends = [];
    }
    const slang = this.lexicon.pick(text, keywords, options.maxSlang ?? this.maxSlang);
    return { trends, slang };
  }
}
