import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildServer, type BuildServerOptions } from '../src/app.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import { TrendService } from '../src/trends/TrendService.js';
import { SlangLexicon } from '../src/trends/SlangLexicon.js';
import type { TrendSource } from '../src/trends/TrendSource.js';
import type { SlangEntry, TrendItem } from '../src/types.js';

export const APP_TOKEN = 'test-token-123456';
export const DEVICE_ID = 'device-test-001';
export const authHeaders = {
  authorization: `Bearer ${APP_TOKEN}`,
  'x-device-id': DEVICE_ID,
  'content-type': 'application/json',
};

export const TEST_SLANG: SlangEntry[] = [
  {
    term: '猫主子',
    aliases: ['猫主人'],
    meaning: '对猫的戏称',
    usageExample: '猫主子今天心情不错',
    tags: ['萌宠'],
    updatedAt: '2026-10-01',
  },
  {
    term: 'yyds',
    aliases: ['永远的神'],
    meaning: '夸特别厉害',
    usageExample: '这波操作yyds',
    tags: ['通用', '夸赞'],
    updatedAt: '2026-10-01',
  },
];

export const TEST_TRENDS: TrendItem[] = [
  { word: '秋天的第一杯奶茶', hotValue: 9_000_000 },
  { word: '猫猫狗狗的迷惑行为', hotValue: 8_000_000 },
  { word: '战争爆发', hotValue: 7_000_000 },
];

export function makeFakeTrendService(
  items: TrendItem[] = TEST_TRENDS,
  slang: SlangEntry[] = TEST_SLANG,
): TrendService {
  const source: TrendSource = { getTrends: async () => items };
  return new TrendService(source, new SlangLexicon(slang));
}

export async function makeTestServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  return buildServer({
    warmTrends: false,
    provider: new MockProvider({ delayMs: 0, chunkDelayMs: 0 }),
    trendService: makeFakeTrendService(),
    ...options,
    config: {
      logLevel: 'silent',
      appToken: APP_TOKEN,
      mock: { delayMs: 0, chunkDelayMs: 0 },
      ...options.config,
    },
  });
}

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo | null;
  if (!address) throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

export interface SseEvent {
  event: string;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) events.push({ event, data });
  }
  return events;
}

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==';

export function tinyPng(): { mime: 'image/png'; data: string } {
  return { mime: 'image/png', data: PNG_1X1 };
}
