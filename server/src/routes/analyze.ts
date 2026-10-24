import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AnalyzeInput, AnalyzeResult, Tone } from '../types.js';
import type { ModelProvider } from '../providers/ModelProvider.js';
import type { TrendService } from '../trends/TrendService.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import type { CountingSemaphore } from '../lib/semaphore.js';
import type { IdempotencyCache } from '../lib/idempotency.js';
import { ApiError, UpstreamError } from '../lib/errors.js';
import { headerString, isValidDeviceId } from '../lib/auth.js';
import { hashShort, isAbortError } from '../lib/text.js';
import { validateImages } from '../lib/images.js';
import { finalizeAnalyzeResult } from '../safety/guards.js';
import { toneSchema } from '../types.js';

/**
 * Exported so tests can check the contract from the client's side: the
 * extension builds this body on its own schedule, and a shape it considers
 * valid but this schema rejects is a silent, total failure of the feature.
 */
export const analyzeBodySchema = z.object({
  requestId: z.string().min(8).max(64),
  app: z.string().min(1).max(40).default('douyin'),
  tone: toneSchema.default('roaster'),
  // Up to dwellSeconds (120s) + repeatDwellSeconds (600s): a repeat line on a
  // long video reports total time on screen, which can exceed 10 minutes.
  dwellMs: z.number().int().min(0).max(900_000).default(0),
  video: z.object({ fingerprint: z.string().max(200) }).optional(),
  ocr: z
    .object({
      text: z.string().max(2000).default(''),
      caption: z.string().max(300).default(''),
      hashtags: z.array(z.string().max(50)).max(10).default([]),
    })
    .default({ text: '', caption: '', hashtags: [] }),
  images: z
    .array(
      z.object({
        mime: z.enum(['image/jpeg', 'image/png']),
        data: z.string().min(8).max(600_000),
      }),
    )
    .max(2)
    .default([]),
  recentReactions: z.array(z.string().max(80)).max(2).default([]),
  // A later reaction to the same long video: continue the thought.
  repeat: z.boolean().default(false),
  // Coarse bucket only. The client never sends raw seconds on purpose.
  videoBucket: z.enum(['short', 'medium', 'long']).optional(),
  // The page rendered its own 「广告」 chip. Optional so older clients still work.
  adLabel: z.boolean().default(false),
});

export interface AnalyzeResponse extends AnalyzeResult {
  requestId: string;
  latencyMs: number;
}

export interface AnalyzeRouteDeps {
  config: AppConfig;
  provider: ModelProvider;
  trendService: TrendService;
  limiter: RateLimiter;
  totalSemaphore: CountingSemaphore;
  visionSemaphore: CountingSemaphore;
  idempotency: IdempotencyCache<AnalyzeResponse>;
}

export function registerAnalyzeRoute(app: FastifyInstance, deps: AnalyzeRouteDeps): void {
  const { config, provider } = deps;

  app.post('/analyze', async (request, reply) => {
    const parsed = analyzeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', '请求参数不合法');
    }
    const body = parsed.data;
    const deviceId = headerString(request.headers['x-device-id']);
    if (!isValidDeviceId(deviceId)) {
      throw new ApiError(422, 'DEVICE_ID_REQUIRED', '缺少有效的 X-Device-Id');
    }

    const deviceKey = hashShort(`${deviceId}|${request.ip}`, 24);
    const idempotencyKey = `${deviceKey}:${body.requestId}`;
    const cached = deps.idempotency.get(idempotencyKey);
    if (cached) return cached;

    const images = validateImages(body.images);

    const decision = deps.limiter.take(deviceKey, [
      { name: 'minute', limit: config.rateLimits.analyzePerMinute, windowMs: 60_000 },
      { name: 'hour', limit: config.rateLimits.analyzePerHour, windowMs: 60 * 60_000 },
      { name: 'day', limit: config.rateLimits.analyzePerDay, windowMs: 24 * 60 * 60_000 },
    ]);
    if (!decision.allowed) {
      reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
      throw new ApiError(429, 'RATE_LIMITED', '请求太频繁，稍后再试', true);
    }

    const releaseTotal = deps.totalSemaphore.tryAcquire();
    if (!releaseTotal) {
      throw new ApiError(429, 'BUSY', '服务正忙，稍后再试', true);
    }
    let releaseVision: (() => void) | null = null;
    if (images.length > 0) {
      releaseVision = deps.visionSemaphore.tryAcquire();
      if (!releaseVision) {
        releaseTotal();
        throw new ApiError(429, 'BUSY', '视觉分析繁忙，稍后再试', true);
      }
    }

    try {
      const contextText = [body.ocr.caption, body.ocr.text, ...body.ocr.hashtags].join(' ');
      const candidates = await deps.trendService.getCandidates(contextText, body.ocr.hashtags).catch(() => ({
        trends: [] as string[],
        slang: [],
      }));

      const input: AnalyzeInput = {
        requestId: body.requestId,
        app: body.app,
        tone: body.tone,
        dwellMs: body.dwellMs,
        fingerprint: body.video?.fingerprint,
        ocr: body.ocr,
        images,
        recentReactions: body.recentReactions,
        repeat: body.repeat,
        videoBucket: body.videoBucket ?? '',
        trendCandidates: candidates.trends,
        slangCandidates: candidates.slang,
      };

      const startedAt = Date.now();
      let raw: AnalyzeResult;
      try {
        raw = await provider.analyze(input, AbortSignal.timeout(config.deepseek.analyzeTimeoutMs));
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (error.code === 'UPSTREAM_TIMEOUT') {
            throw new ApiError(504, 'UPSTREAM_TIMEOUT', '模型响应超时，请重试', error.retryable);
          }
          if (error.code === 'UPSTREAM_AUTH') {
            throw new ApiError(502, 'UPSTREAM_AUTH', '模型访问令牌无效，检查服务端 DEEPSEEK_API_KEY', false);
          }
          if (error.status === 400 || error.status === 404) {
            // Usually a wrong model id or a model without vision support.
            throw new ApiError(502, 'MODEL_UNAVAILABLE', '模型名或能力不匹配，检查 MODEL_VISION', false);
          }
          throw new ApiError(502, 'UPSTREAM_ERROR', '模型服务暂时不可用', error.retryable);
        }
        if (isAbortError(error)) {
          throw new ApiError(504, 'UPSTREAM_TIMEOUT', '模型响应超时，请重试', true);
        }
        request.log.error({ requestId: body.requestId, err: (error as Error).name }, 'analyze provider failed');
        throw new ApiError(502, 'UPSTREAM_ERROR', '模型服务暂时不可用', true);
      }

      // The page's own ad chip is a stronger signal than the model's guess, so
      // it is passed as a confirmed flag. It is deliberately NOT folded into
      // `raw.isAd`: that flag still needs a text marker to agree, and mixing
      // the two would make "the page said so" indistinguishable from a guess.
      const result = finalizeAnalyzeResult(
        raw,
        candidates.slang,
        candidates.trends,
        body.tone as Tone,
        body.adLabel,
      );
      const latencyMs = Date.now() - startedAt;
      const response: AnalyzeResponse = { requestId: body.requestId, ...result, latencyMs };
      deps.idempotency.set(idempotencyKey, response);

      request.log.info(
        {
          requestId: body.requestId,
          provider: provider.name,
          imageCount: images.length,
          imageBytes: images.reduce((sum, image) => sum + image.bytes, 0),
          latencyMs,
          risk: result.risk,
        },
        'analyze completed',
      );

      return response;
    } finally {
      releaseVision?.();
      releaseTotal();
    }
  });
}
