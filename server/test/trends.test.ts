import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SixtySecondsSource } from '../src/trends/SixtySecondsSource.js';
import { filterSafeTrends, selectTrendCandidates } from '../src/trends/TrendFilter.js';
import { TrendService } from '../src/trends/TrendService.js';
import { SlangLexicon } from '../src/trends/SlangLexicon.js';
import type { TrendSource } from '../src/trends/TrendSource.js';
import { authHeaders, makeTestServer, TEST_SLANG } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('trend filtering', () => {
  it('drops sensitive words and keeps entertainment topics', () => {
    const safe = filterSafeTrends([
      { word: '战争爆发', hotValue: 1 },
      { word: '猫猫狗狗的迷惑行为', hotValue: 2 },
      { word: '秋天的第一杯奶茶', hotValue: 3 },
      { word: '猫猫狗狗的迷惑行为', hotValue: 4 },
    ]);
    expect(safe.map((item) => item.word)).toEqual(['猫猫狗狗的迷惑行为', '秋天的第一杯奶茶']);
  });

  it('only picks trends that overlap the current caption', () => {
    const items = [
      { word: '秋天的第一杯奶茶', hotValue: 1 },
      { word: '猫猫狗狗的迷惑行为', hotValue: 2 },
    ];
    expect(selectTrendCandidates(items, '今天喝了秋天的第一杯奶茶', 3)).toEqual(['秋天的第一杯奶茶']);
    expect(selectTrendCandidates(items, '完全无关的做饭视频', 3)).toEqual([]);
    expect(selectTrendCandidates(items, '', 3)).toEqual([]);
  });
});

describe('SixtySecondsSource', () => {
  it('caches for the TTL and then refreshes', async () => {
    let now = 0;
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: [
            { word: '秋天的第一杯奶茶', hot_value: 100 },
            { word: '战争爆发', hot_value: 99 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const source = new SixtySecondsSource({
      url: 'http://example.test/hot',
      ttlMs: 1_000,
      now: () => now,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const first = await source.getTrends();
    expect(first.map((item) => item.word)).toEqual(['秋天的第一杯奶茶']);
    await source.getTrends();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now = 2_000;
    await source.getTrends();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps last-good data when the upstream fails', async () => {
    let now = 0;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ word: '猫猫狗狗的迷惑行为', hot_value: 1 }] }), {
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new Error('offline'));
    const source = new SixtySecondsSource({
      url: 'http://example.test/hot',
      ttlMs: 1_000,
      now: () => now,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect((await source.getTrends()).length).toBe(1);
    now = 2_000;
    expect((await source.getTrends()).map((item) => item.word)).toEqual(['猫猫狗狗的迷惑行为']);
  });

  it('falls back to the bundled snapshot on first failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'video-buddy-'));
    tempDirs.push(dir);
    const snapshotPath = join(dir, 'snapshot.json');
    writeFileSync(
      snapshotPath,
      JSON.stringify({ items: [{ word: '谁懂这一口的含金量', hot_value: 1 }] }),
      'utf8',
    );
    const source = new SixtySecondsSource({
      url: 'http://example.test/hot',
      snapshotPath,
      fetchFn: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect((await source.getTrends()).map((item) => item.word)).toEqual(['谁懂这一口的含金量']);
  });
});

describe('TrendService', () => {
  it('never fails when the trend source throws', async () => {
    const broken: TrendSource = {
      getTrends: async () => {
        throw new Error('down');
      },
    };
    const service = new TrendService(broken, new SlangLexicon(TEST_SLANG));
    const candidates = await service.getCandidates('猫主子今天拆家了');
    expect(candidates.trends).toEqual([]);
    expect(candidates.slang.map((entry) => entry.term)).toContain('猫主子');
  });

  it('serves debug candidates through /v1/trends', async () => {
    let app: FastifyInstance | undefined;
    try {
      app = await makeTestServer();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/trends?q=' + encodeURIComponent('秋天的第一杯奶茶'),
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().trends).toContain('秋天的第一杯奶茶');
    } finally {
      await app?.close();
    }
  });
});
