import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { ChatInput, ChatTurn } from '../types.js';
import type { ModelProvider } from '../providers/ModelProvider.js';
import type { TrendService } from '../trends/TrendService.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import type { CountingSemaphore } from '../lib/semaphore.js';
import { ApiError, UpstreamError, errorBody } from '../lib/errors.js';
import { headerString, isValidDeviceId } from '../lib/auth.js';
import { hashShort, isAbortError } from '../lib/text.js';
import { pickChatEmotion } from '../prompts/zh.js';
import { createMaomaoStreamFilter } from '../safety/voiceFilter.js';
import { toneSchema } from '../types.js';

const chatBodySchema = z.object({
  requestId: z.string().min(8).max(64),
  sessionId: z.string().min(8).max(64),
  tone: toneSchema.default('roaster'),
  message: z.string().trim().min(1).max(1000),
  context: z
    .object({
      summary: z.string().max(500).optional(),
      keywords: z.array(z.string().max(30)).max(10).optional(),
      caption: z.string().max(300).optional(),
    })
    .default({}),
  history: z
    .array(
      z.object({
        role: z.string().max(20),
        content: z.string().max(2000),
      }),
    )
    .max(30)
    .default([]),
  privacyTextOnly: z.boolean().default(false),
  // Optional: the client reports how often each emotion has come up so far.
  // Unknown keys are dropped and values are clamped, so a malformed or
  // hostile tally can only make the choice more uniform, never break a turn.
  emotionTally: z
    .record(z.string().max(20), z.number().int().min(0).max(10_000))
    .optional(),
});

export interface ChatRouteDeps {
  config: AppConfig;
  provider: ModelProvider;
  trendService: TrendService;
  limiter: RateLimiter;
  totalSemaphore: CountingSemaphore;
}

export function registerChatRoute(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { config, provider } = deps;

  app.post('/chat', async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', '请求参数不合法');
    }
    const body = parsed.data;
    const deviceId = headerString(request.headers['x-device-id']);
    if (!isValidDeviceId(deviceId)) {
      throw new ApiError(422, 'DEVICE_ID_REQUIRED', '缺少有效的 X-Device-Id');
    }

    const deviceKey = hashShort(`${deviceId}|${request.ip}`, 24);
    const decision = deps.limiter.take(deviceKey, [
      { name: 'minute', limit: config.rateLimits.chatPerMinute, windowMs: 60_000 },
      { name: 'day', limit: config.rateLimits.chatPerDay, windowMs: 24 * 60 * 60_000 },
    ]);
    if (!decision.allowed) {
      reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
      throw new ApiError(429, 'RATE_LIMITED', '聊得太快了，喘口气再发', true);
    }

    const releaseTotal = deps.totalSemaphore.tryAcquire();
    if (!releaseTotal) {
      throw new ApiError(429, 'BUSY', '服务正忙，稍后再试', true);
    }

    let hijacked = false;
    try {
      const history: ChatTurn[] = body.history
        .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
        .filter((turn) => turn.content.trim().length > 0)
        .slice(-12)
        .map((turn) => ({ role: turn.role as ChatTurn['role'], content: turn.content }));

      const contextText = [body.context.summary, body.context.caption, ...(body.context.keywords ?? [])]
        .filter(Boolean)
        .join(' ');

      const candidates = await withTimeout(
        deps.trendService.getCandidates(contextText, body.context.keywords ?? []),
        1_500,
        { trends: [] as string[], slang: [] },
      );

      const input: ChatInput = {
        requestId: body.requestId,
        sessionId: body.sessionId,
        tone: body.tone,
        message: body.message,
        context: body.context,
        history,
        trendCandidates: candidates.trends,
        slangCandidates: candidates.slang,
        privacyTextOnly: body.privacyTextOnly,
        emotionTally: body.emotionTally,
      };
      const emotionHint = pickChatEmotion(input);

      reply.hijack();
      hijacked = true;

      const response = reply.raw;
      const controller = new AbortController();
      let finished = false;
      let clientGone = false;
      const startedAt = Date.now();
      let chars = 0;

      response.on('close', () => {
        if (!finished) {
          clientGone = true;
          controller.abort();
        }
      });

      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(`event: meta\ndata: ${JSON.stringify({ requestId: body.requestId, model: provider.chatModel })}\n\n`);

      const heartbeat = setInterval(() => {
        if (!finished && !response.writableEnded) {
          response.write(': ping\n\n');
        }
      }, 15_000);

      try {
        // Real models do not reliably honour the voice rules, so enforce them
        // here as a last line of defence instead of trusting the prompt.
        const voice = input.tone === 'maomao' ? createMaomaoStreamFilter() : null;
        for await (const delta of provider.streamChat(input, controller.signal)) {
          if (clientGone) break;
          const text = voice ? voice.push(delta) : delta;
          if (!text) continue;
          chars += text.length;
          response.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
        }
        if (!clientGone && voice) {
          const tail = voice.flush();
          if (tail) {
            chars += tail.length;
            response.write(`event: delta\ndata: ${JSON.stringify({ text: tail })}\n\n`);
          }
        }
        if (!clientGone) {
          response.write(
            `event: done\ndata: ${JSON.stringify({
              finishReason: 'stop',
              ...(emotionHint ? { emotion: emotionHint } : {}),
            })}\n\n`,
          );
        }
      } catch (error) {
        if (!clientGone) {
          if (error instanceof UpstreamError) {
            const info = upstreamErrorInfo(error);
            response.write(`event: error\ndata: ${JSON.stringify(errorBody(info.code, info.message, error.retryable))}\n\n`);
          } else if (!isAbortError(error)) {
            response.write(
              `event: error\ndata: ${JSON.stringify(errorBody('UPSTREAM_ERROR', '模型服务暂时不可用', true))}\n\n`,
            );
          }
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        request.log.info(
          { requestId: body.requestId, provider: provider.name, chars, latencyMs: Date.now() - startedAt, clientGone },
          'chat finished',
        );
        if (!response.writableEnded) response.end();
      }
    } finally {
      releaseTotal();
    }
  });
}

/** Map provider failures to stable client-facing codes and Chinese copy. */
function upstreamErrorInfo(error: UpstreamError): { code: string; message: string } {
  switch (error.code) {
    case 'UPSTREAM_TIMEOUT':
      return { code: 'UPSTREAM_TIMEOUT', message: '模型响应超时' };
    case 'UPSTREAM_AUTH':
      return { code: 'UPSTREAM_AUTH', message: '模型访问令牌无效，检查服务端 DEEPSEEK_API_KEY' };
    case 'UPSTREAM_PROTOCOL':
      return { code: 'UPSTREAM_PROTOCOL', message: '模型输出格式不对，再问一次' };
    default:
      if (error.status === 400 || error.status === 404) {
        return { code: 'MODEL_UNAVAILABLE', message: '模型名或能力不匹配，检查 MODEL_CHAT' };
      }
      return { code: 'UPSTREAM_ERROR', message: '模型服务暂时不可用' };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
