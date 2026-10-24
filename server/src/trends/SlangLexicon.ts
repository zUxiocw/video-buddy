import { readFileSync } from 'node:fs';
import '../../../extension/shared/zh-prompt.js';
import type { SlangEntry } from '../types.js';
import { dataFile } from '../lib/dataPath.js';
import { clampText, normalizeForMatch } from '../lib/text.js';
import { containsBlockedTerm } from '../safety/guards.js';

const DEFAULT_SLANG_PATH = dataFile('slang.json', import.meta.url);

const promptApi = (globalThis as unknown as {
  SmPrompt: { formatSlangForPrompt(entry: SlangEntry): string };
}).SmPrompt;
if (!promptApi) {
  throw new Error('extension/shared/zh-prompt.js did not install globalThis.SmPrompt');
}

/**
 * Curated, hand-maintained slang. Kept small and safe on purpose.
 * Candidates are matched by term/alias/tag, then optionally topped up with
 * a couple of general-purpose entries.
 */
export class SlangLexicon {
  private readonly entries: SlangEntry[];

  constructor(entries: SlangEntry[]) {
    this.entries = entries
      .filter((entry) => entry && typeof entry.term === 'string' && entry.term.trim().length > 0)
      .filter((entry) => !containsBlockedTerm(`${entry.term} ${entry.meaning} ${entry.usageExample}`))
      .map((entry) => ({
        term: clampText(entry.term, 20),
        aliases: (entry.aliases ?? []).map((alias) => clampText(alias, 20)).filter(Boolean).slice(0, 5),
        meaning: clampText(entry.meaning, 60),
        usageExample: clampText(entry.usageExample, 80),
        tags: (entry.tags ?? []).map((tag) => clampText(tag, 10)).filter(Boolean).slice(0, 8),
        updatedAt: clampText(entry.updatedAt, 20),
      }));
  }

  static fromFile(path = DEFAULT_SLANG_PATH): SlangLexicon {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed: unknown = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { items?: unknown }).items)
          ? (parsed as { items: unknown[] }).items
          : [];
      return new SlangLexicon(list as SlangEntry[]);
    } catch (error) {
      console.warn('[slang] failed to load lexicon:', (error as Error).message);
      return new SlangLexicon([]);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  pick(text: string, keywords: string[] = [], max = 3): SlangEntry[] {
    const haystackRaw = `${text} ${keywords.join(' ')}`;
    const haystack = normalizeForMatch(haystackRaw);
    if (!haystack) return [];

    const matched: SlangEntry[] = [];
    for (const entry of this.entries) {
      const names = [entry.term, ...entry.aliases].map(normalizeForMatch).filter(Boolean);
      const termHit = names.some((name) => haystack.includes(name));
      const tagHit = entry.tags.some((tag) => {
        const normalized = normalizeForMatch(tag);
        return normalized.length >= 2 && haystack.includes(normalized);
      });
      if (termHit || tagHit) matched.push(entry);
      if (matched.length >= max) break;
    }

    if (matched.length > 0) return matched;
    return this.entries.filter((entry) => entry.tags.includes('通用')).slice(0, 2);
  }
}

/**
 * Delegates to the shared prompt module so the server and the BYOK path format
 * slang identically. Re-exported from here because callers import it from the
 * lexicon, which is where the entries come from.
 */
export function formatSlangForPrompt(entry: SlangEntry): string {
  return promptApi.formatSlangForPrompt(entry);
}
