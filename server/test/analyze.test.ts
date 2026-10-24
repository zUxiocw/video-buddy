import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AnalyzeResult } from '../src/types.js';
import { UpstreamError } from '../src/lib/errors.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import { authHeaders, makeTestServer, tinyPng } from './helpers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 12)}`,
    app: 'douyin',
    tone: 'roaster',
    dwellMs: 5600,
    video: { fingerprint: 'abcd1234:ef567890' },
    ocr: {
      text: '猫主子又在拆家了 #萌宠',
      caption: '猫主子又拆家了 #萌宠',
      hashtags: ['萌宠'],
    },
    images: [],
    recentReactions: [],
    ...overrides,
  };
}

describe('POST /v1/analyze', () => {
  it('returns a summary and proactive reaction', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({ requestId: 'analyze-000001' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe('analyze-000001');
    expect(body.summary).toContain('猫主子');
    expect(Array.isArray(body.keywords)).toBe(true);
    expect(body.keywords.length).toBeGreaterThan(0);
    expect(typeof body.reaction).toBe('string');
    expect(body.reaction.length).toBeGreaterThan(0);
    expect(body.risk).toBe('ok');
    expect(typeof body.latencyMs).toBe('number');
    expect(body.memeUsed).toBe('猫主子');
  });

  it('uses injected trends when the caption overlaps', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000002',
        ocr: { text: '秋天的第一杯奶茶', caption: '秋天的第一杯奶茶安排上了', hashtags: ['奶茶'] },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toContain('奶茶');
  });

  it('accepts a small PNG', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({ requestId: 'analyze-000003', images: [tinyPng()] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().risk).toBe('ok');
  });

  it('rejects invalid base64 and mime mismatch', async () => {
    app = await makeTestServer();
    const badBase64 = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000004',
        images: [{ mime: 'image/jpeg', data: '!!!!not-base64!!!!' }],
      }),
    });
    expect(badBase64.statusCode).toBe(422);
    expect(badBase64.json().error.code).toBe('INVALID_IMAGE');

    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000005',
        images: [{ mime: 'image/jpeg', data: tinyPng().data }],
      }),
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('IMAGE_MIME_MISMATCH');
  });

  it('rejects an image over 400KiB', async () => {
    app = await makeTestServer();
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const huge = Buffer.concat([pngMagic, Buffer.alloc(400 * 1024)]).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000006',
        images: [{ mime: 'image/png', data: huge }],
      }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('enforces the 1.5MiB body limit', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000007',
        ocr: { text: 'a'.repeat(1_600_000), caption: '', hashtags: [] },
      }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('is idempotent and rate limited', async () => {
    app = await makeTestServer({
      config: {
        rateLimits: {
          analyzePerMinute: 1,
          analyzePerHour: 60,
          analyzePerDay: 300,
          chatPerMinute: 20,
          chatPerDay: 500,
          visionConcurrency: 4,
          totalConcurrency: 8,
        },
      },
    });
    const body = payload({ requestId: 'analyze-000008' });
    const first = await app.inject({ method: 'POST', url: '/v1/analyze', headers: authHeaders, payload: body });
    expect(first.statusCode).toBe(200);

    const duplicate = await app.inject({ method: 'POST', url: '/v1/analyze', headers: authHeaders, payload: body });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(first.json());

    const second = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({ requestId: 'analyze-000009' }),
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('never returns a reaction for blocked content', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000010',
        ocr: { text: '战争爆发，现场一片混乱', caption: '最新战况', hashtags: ['军事'] },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.risk).toBe('blocked');
    expect(body.reaction).toBe('');
    expect(body.memeUsed).toBeNull();
  });

  it('stays neutral when there is no usable screen text', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({
        requestId: 'analyze-000011',
        ocr: { text: '', caption: '', hashtags: [] },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.risk).toBe('ok');
    expect(body.reaction).toContain('没');
  });

  it('maps a bad upstream key to UPSTREAM_AUTH', async () => {
    class AuthFailProvider extends MockProvider {
      override async analyze(): Promise<AnalyzeResult> {
        throw new UpstreamError('UPSTREAM_AUTH', 'auth', false, 401);
      }
    }
    app = await makeTestServer({ provider: new AuthFailProvider() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({ requestId: 'analyze-000013' }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM_AUTH');
    expect(res.json().error.retryable).toBe(false);
  });

  it('maps an unknown model id to MODEL_UNAVAILABLE', async () => {
    class BadModelProvider extends MockProvider {
      override async analyze(): Promise<AnalyzeResult> {
        throw new UpstreamError('UPSTREAM_ERROR', 'bad model', false, 404);
      }
    }
    app = await makeTestServer({ provider: new BadModelProvider() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({ requestId: 'analyze-000014' }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('MODEL_UNAVAILABLE');
  });

  it('maps upstream timeout to 504', async () => {
    class TimeoutProvider extends MockProvider {
      override async analyze(): Promise<AnalyzeResult> {
        throw new UpstreamError('UPSTREAM_TIMEOUT', 'timeout');
      }
    }
    app = await makeTestServer({ provider: new TimeoutProvider() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: payload({ requestId: 'analyze-000012' }),
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });
});
