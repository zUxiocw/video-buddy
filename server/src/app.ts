import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { loadConfig, type AppConfig } from './config.js';
import { createProvider } from './providers/index.js';
import type { ModelProvider } from './providers/ModelProvider.js';
import { SixtySecondsSource } from './trends/SixtySecondsSource.js';
import { SlangLexicon } from './trends/SlangLexicon.js';
import { TrendService } from './trends/TrendService.js';
import { RateLimiter } from './lib/rateLimit.js';
import { CountingSemaphore } from './lib/semaphore.js';
import { IdempotencyCache } from './lib/idempotency.js';
import { ApiError, errorBody } from './lib/errors.js';
import { checkBearer } from './lib/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAnalyzeRoute, type AnalyzeResponse } from './routes/analyze.js';
import { registerChatRoute } from './routes/chat.js';
import { registerTrendsRoute } from './routes/trends.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface BuildServerOptions {
  config?: DeepPartial<AppConfig>;
  provider?: ModelProvider;
  trendService?: TrendService;
  /** Disable the background trend warm-up (tests). */
  warmTrends?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = mergeConfig(loadConfig(), options.config ?? {});

  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: ['req.headers.authorization', 'req.headers["x-device-id"]'],
              censor: '[redacted]',
            },
          },
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
  });

  const provider = options.provider ?? createProvider(config);
  const trendService =
    options.trendService ??
    new TrendService(
      new SixtySecondsSource({
        url: config.trends.url,
        ttlMs: config.trends.ttlMs,
        snapshotPath: config.trends.snapshotPath ?? undefined,
        onWarning: (message) => app.log.warn(message),
      }),
      SlangLexicon.fromFile(),
    );

  const totalSemaphore = new CountingSemaphore(config.rateLimits.totalConcurrency);
  const visionSemaphore = new CountingSemaphore(config.rateLimits.visionConcurrency);
  const analyzeLimiter = new RateLimiter();
  const chatLimiter = new RateLimiter();
  const idempotency = new IdempotencyCache<AnalyzeResponse>(config.idempotencyTtlMs);

  registerHealthRoute(app, { config, provider });

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send(errorBody('NOT_FOUND', '接口不存在', false, String(request.id)));
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const requestId = bodyRequestId(request);
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ code: error.code, status: error.statusCode }, 'request failed');
      }
      await reply.code(error.statusCode).send(error.toBody(requestId));
      return;
    }

    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      await reply.code(413).send(errorBody('PAYLOAD_TOO_LARGE', '请求体过大，最多 1.5MiB', false, requestId));
      return;
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      await reply.code(415).send(errorBody('UNSUPPORTED_MEDIA_TYPE', '只支持 application/json', false, requestId));
      return;
    }
    if (
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      await reply.code(422).send(errorBody('VALIDATION_ERROR', '请求体不是合法 JSON', false, requestId));
      return;
    }

    request.log.error({ code: error.code, status: error.statusCode ?? 500 }, 'unhandled request error');
    await reply.code(500).send(errorBody('INTERNAL_ERROR', '服务器开小差了，请稍后再试', true, requestId));
  });

  await app.register(
    async (v1) => {
      v1.addHook('preHandler', async (request, reply) => {
        if (!checkBearer(request.headers.authorization, config.appToken)) {
          await reply
            .code(401)
            .header('www-authenticate', 'Bearer')
            .send(errorBody('UNAUTHORIZED', '无效的访问令牌', false, String(request.id)));
        }
      });

      registerAnalyzeRoute(v1, {
        config,
        provider,
        trendService,
        limiter: analyzeLimiter,
        totalSemaphore,
        visionSemaphore,
        idempotency,
      });
      registerChatRoute(v1, {
        config,
        provider,
        trendService,
        limiter: chatLimiter,
        totalSemaphore,
      });
      registerTrendsRoute(v1, { trendService });
    },
    { prefix: '/v1' },
  );

  if (options.warmTrends !== false) {
    // Best-effort: fill the 45-minute trend cache before the first video trigger.
    void trendService.getCandidates('', []).catch(() => {});
  }

  return app;
}

function bodyRequestId(request: FastifyRequest): string {
  const body = request.body as { requestId?: unknown } | undefined;
  if (body && typeof body === 'object' && typeof body.requestId === 'string') {
    const value = body.requestId.trim();
    if (value.length >= 8 && value.length <= 64) return value;
  }
  return String(request.id);
}

function mergeConfig<T>(base: T, patch: DeepPartial<T>): T;
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch ?? base;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = base[key];
    merged[key] = isPlainObject(value) && isPlainObject(current) ? mergeConfig(current, value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
