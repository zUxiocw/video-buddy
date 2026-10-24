import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildAnalyzeMessages } from '../src/prompts/zh.js';
import { analyzeBodySchema } from '../src/routes/analyze.js';
import type { AnalyzeInput } from '../src/types.js';

const coreSource = readFileSync(
  fileURLToPath(new URL('../../extension/shared/core.js', import.meta.url)),
  'utf8',
);
const coreContext = { console, URL, Number, Math, String, Object, Array, Uint8Array, Date };
vm.createContext(coreContext);
vm.runInContext(coreSource, coreContext);

interface CoreApi {
  frameSamplePoints(count?: number): number[];
  videoBucket(seconds: unknown): string;
  buildAnalyzeBody(input: Record<string, unknown>): Record<string, any>;
}

const Buddy = (coreContext as unknown as { Buddy: CoreApi }).Buddy;

const baseInput: AnalyzeInput = {
  requestId: 'frames-1',
  app: 'douyin',
  tone: 'maomao',
  dwellMs: 8000,
  ocr: { text: '猫在拆家', caption: '猫主子拆家了', hashtags: [] },
  images: [],
  recentReactions: [],
  trendCandidates: [],
  slangCandidates: [],
};

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

describe('frameSamplePoints', () => {
  it('returns an increasing list ending at 1', () => {
    const points = Buddy.frameSamplePoints(4);
    expect(points).toHaveLength(4);
    expect(points[points.length - 1]).toBe(1);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    }
  });

  it('starts early enough to catch the opening of a short clip', () => {
    // Four samples over an 8s wait: the first must land well before the end,
    // otherwise a 5s clip is already looping before we see anything.
    expect(Buddy.frameSamplePoints(4)[0]).toBeLessThanOrEqual(0.35);
  });

  it('clamps the count and still behaves at the edges', () => {
    expect(Buddy.frameSamplePoints(1)).toEqual([1]);
    expect(Buddy.frameSamplePoints(0)).toHaveLength(1);
    expect(Buddy.frameSamplePoints(99)).toHaveLength(6);
    expect(Buddy.frameSamplePoints(undefined)).toHaveLength(4);
    expect(Buddy.frameSamplePoints(6).at(-1)).toBe(1);
  });
});

describe('videoBucket', () => {
  it('buckets by length', () => {
    expect(Buddy.videoBucket(9)).toBe('short');
    expect(Buddy.videoBucket(29.9)).toBe('short');
    expect(Buddy.videoBucket(30)).toBe('medium');
    expect(Buddy.videoBucket(179)).toBe('medium');
    expect(Buddy.videoBucket(180)).toBe('long');
    expect(Buddy.videoBucket(60 * 60)).toBe('long');
  });

  it('returns empty for a duration it cannot trust', () => {
    // Live streams report Infinity; an unloaded video reports NaN.
    expect(Buddy.videoBucket(Infinity)).toBe('');
    expect(Buddy.videoBucket(NaN)).toBe('');
    expect(Buddy.videoBucket(0)).toBe('');
    expect(Buddy.videoBucket(-5)).toBe('');
    expect(Buddy.videoBucket(undefined)).toBe('');
  });
});

describe('analyze body carries a bucket, not seconds', () => {
  it('converts duration to a bucket and drops the number', () => {
    const body = Buddy.buildAnalyzeBody({ videoDuration: 15 });
    expect(body.videoBucket).toBe('short');
    // Assert on fields rather than the serialized body: requestId is a random
    // UUID, so a whole-string search for "15" fails by chance about 1 run in 6.
    expect(body).not.toHaveProperty('videoDuration');
    expect(body).not.toHaveProperty('duration');
    const numbers = Object.values(body).filter((value) => typeof value === 'number');
    expect(numbers).not.toContain(15);
  });

  it('omits the key entirely when the duration is unknown', () => {
    // Not `videoBucket: ''`: the server schema is a strict enum, so an empty
    // string is rejected as invalid input and the reaction never arrives.
    // Live streams (Infinity) and videos that have not loaded (NaN) hit this.
    for (const input of [{}, { videoDuration: Infinity }, { videoDuration: NaN }, { videoDuration: 0 }]) {
      expect(Buddy.buildAnalyzeBody(input)).not.toHaveProperty('videoBucket');
    }
  });
});

describe('analyze body stays inside the server schema', () => {
  // The extension and the server are edited separately, so a shape the client
  // happily builds can still be a 422. This caught a real regression: an empty
  // videoBucket and an unclamped long-watch dwellMs both rejected every request
  // on live streams and on long videos with repeats.
  it('accepts every body the extension can produce', () => {
    const bodies = [
      Buddy.buildAnalyzeBody({}),
      Buddy.buildAnalyzeBody({ videoDuration: Infinity, dwellMs: 8000 }),
      Buddy.buildAnalyzeBody({ videoDuration: 15, dwellMs: 848000, repeat: true }),
      Buddy.buildAnalyzeBody({ videoDuration: 3600, dwellMs: 1_320_000, repeat: true }),
      Buddy.buildAnalyzeBody({ videoDuration: 5, dwellMs: 99_999_999, adLabel: true }),
    ];
    for (const body of bodies) {
      const parsed = analyzeBodySchema.safeParse(body);
      const issues = parsed.success ? '' : JSON.stringify(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      expect(parsed.success, issues).toBe(true);
    }
  });

  it('clamps a long-watch dwellMs instead of sending an invalid one', () => {
    // dwellSeconds + n * repeatDwellSeconds keeps growing; at the largest
    // settings the third line already passes 15 minutes.
    expect(Buddy.buildAnalyzeBody({ dwellMs: 1_320_000 }).dwellMs).toBe(900_000);
    expect(Buddy.buildAnalyzeBody({ dwellMs: -1 }).dwellMs).toBe(0);
  });
});

describe('image and length hints in the analyze prompt', () => {
  it('tells the model the image may be a composite', () => {
    const text = promptText(buildAnalyzeMessages(baseInput, 'low'));
    expect(text).toContain('几帧拼在一起');
    expect(text).toContain('左上角数字是先后顺序');
    expect(text).toContain('不要推断');
  });

  it('adds a qualitative hint per bucket and nothing for unknown', () => {
    const short = promptText(buildAnalyzeMessages({ ...baseInput, videoBucket: 'short' }, 'low'));
    const long = promptText(buildAnalyzeMessages({ ...baseInput, videoBucket: 'long' }, 'low'));
    const unknown = promptText(buildAnalyzeMessages({ ...baseInput, videoBucket: '' }, 'low'));

    expect(short).toContain('很短的视频');
    expect(long).toContain('偏长的视频');
    expect(unknown).not.toContain('很短的视频');
    expect(unknown).not.toContain('偏长的视频');
  });

  it('never leaks a duration alongside the bucket', () => {
    const duration = /\d+\s*(秒|分钟)|毫秒/;
    for (const videoBucket of ['short', 'medium', 'long']) {
      const text = promptText(buildAnalyzeMessages({ ...baseInput, videoBucket }, 'low'));
      expect(text, videoBucket).not.toMatch(duration);
    }
  });
});
