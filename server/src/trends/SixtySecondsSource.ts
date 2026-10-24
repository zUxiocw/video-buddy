import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TrendItem } from '../types.js';
import type { TrendSource } from './TrendSource.js';
import { filterSafeTrends } from './TrendFilter.js';

const DEFAULT_SNAPSHOT_PATH = fileURLToPath(new URL('../../data/hot-snapshot.json', import.meta.url));

export interface SixtySecondsSourceOptions {
  url: string;
  ttlMs?: number;
  timeoutMs?: number;
  snapshotPath?: string;
  now?: () => number;
  fetchFn?: typeof fetch;
  onWarning?: (message: string) => void;
}

/**
 * Douyin hot list from the public 60s instance.
 * Cache for 45 minutes, keep last-good, fall back to a bundled safe snapshot.
 */
export class SixtySecondsSource implements TrendSource {
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly snapshotPath: string;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly onWarning: (message: string) => void;

  private cached: TrendItem[] | null = null;
  private cachedAt = Number.NEGATIVE_INFINITY;
  private lastGood: TrendItem[] | null = null;
  private snapshot: TrendItem[] | null = null;

  constructor(options: SixtySecondsSourceOptions) {
    this.url = options.url;
    this.ttlMs = options.ttlMs ?? 45 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.snapshotPath = options.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
    this.now = options.now ?? Date.now;
    this.fetchFn = options.fetchFn ?? fetch;
    this.onWarning = options.onWarning ?? (() => {});
  }

  async getTrends(): Promise<TrendItem[]> {
    const now = this.now();
    if (this.cached && now - this.cachedAt < this.ttlMs) {
      return this.cached;
    }

    try {
      const response = await this.fetchFn(this.url, {
        headers: { accept: 'application/json', 'user-agent': 'video-buddy/0.1' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json: unknown = await response.json();
      const items = filterSafeTrends(extractItems(json));
      if (items.length === 0) throw new Error('empty hot list');
      this.lastGood = items;
      return this.store(items, now);
    } catch (error) {
      this.onWarning(`trend source failed: ${(error as Error).message}`);
      const fallback = this.lastGood ?? this.loadSnapshot();
      return this.store(fallback, now);
    }
  }

  private store(items: TrendItem[], now: number): TrendItem[] {
    this.cached = items;
    this.cachedAt = now;
    return items;
  }

  private loadSnapshot(): TrendItem[] {
    if (this.snapshot) return this.snapshot;
    try {
      const raw = readFileSync(this.snapshotPath, 'utf8');
      const json: unknown = JSON.parse(raw) as unknown;
      this.snapshot = filterSafeTrends(extractItems(json));
    } catch (error) {
      this.onWarning(`trend snapshot unavailable: ${(error as Error).message}`);
      this.snapshot = [];
    }
    return this.snapshot;
  }
}

function extractItems(json: unknown): TrendItem[] {
  const root = json as Record<string, unknown> | unknown[] | null;
  let list: unknown[] = [];
  if (Array.isArray(root)) {
    list = root;
  } else if (root && typeof root === 'object') {
    const data = (root as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).items)) {
      list = (data as Record<string, unknown>).items as unknown[];
    } else if (Array.isArray((root as Record<string, unknown>).items)) {
      list = (root as Record<string, unknown>).items as unknown[];
    }
  }

  const out: TrendItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const word = record.word ?? record.title ?? record.name;
    if (typeof word !== 'string') continue;
    const hotRaw = record.hot_value ?? record.hotValue ?? record.hot;
    const hotValue =
      typeof hotRaw === 'number'
        ? hotRaw
        : typeof hotRaw === 'string' && hotRaw.trim() !== '' && Number.isFinite(Number(hotRaw))
          ? Number(hotRaw)
          : undefined;
    out.push({ word, ...(hotValue !== undefined ? { hotValue } : {}) });
  }
  return out;
}
