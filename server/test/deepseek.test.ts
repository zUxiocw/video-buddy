import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { DeepSeekProvider } from '../src/providers/DeepSeekProvider.js';
import { UpstreamError } from '../src/lib/errors.js';
import type { AnalyzeInput, ChatInput } from '../src/types.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function deepseekConfig(overrides: Partial<AppConfig['deepseek']> = {}): AppConfig['deepseek'] {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.test',
    visionModel: 'deepseek-flash',
    chatModel: 'deepseek-flash',
    thinking: 'disabled',
    visionDetail: 'high',
    upstreamTimeoutMs: 5_000,
    analyzeTimeoutMs: 5_000,
    chatTimeoutMs: 5_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function analyzeInput(): AnalyzeInput {
  return {
    requestId: 'deepseek-analyze-001',
    app: 'douyin',
    tone: 'maomao',
    dwellMs: 5_600,
    ocr: { text: '猫在拆家', caption: '猫主子又拆家了', hashtags: ['萌宠'] },
    images: [],
    recentReactions: [],
    trendCandidates: [],
    slangCandidates: [],
  };
}

function chatInput(): ChatInput {
  return {
    requestId: 'deepseek-chat-001',
    sessionId: 'session-deepseek-01',
    tone: 'maomao',
    message: '这视频讲了啥',
    context: { summary: '猫在拆家', keywords: ['猫'], caption: '猫主子又拆家了' },
    history: [],
    trendCandidates: [],
    slangCandidates: [],
    privacyTextOnly: true,
  };
}

describe('DeepSeekProvider', () => {
  it('sends the model, auth header and thinking flag from config', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ choices: [{ message: { content: '{"summary":"猫在拆家"}' } }] });
    }) as typeof fetch;

    const provider = new DeepSeekProvider(deepseekConfig());
    await provider.analyze(analyzeInput(), AbortSignal.timeout(4_000));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.test/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(false);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('maps 401 to a non-retryable auth error', async () => {
    globalThis.fetch = (async () => jsonResponse({}, 401)) as typeof fetch;
    const provider = new DeepSeekProvider(deepseekConfig());

    await expect(provider.analyze(analyzeInput(), AbortSignal.timeout(4_000))).rejects.toMatchObject({
      code: 'UPSTREAM_AUTH',
      retryable: false,
      status: 401,
    });
  });

  it('keeps 5xx retryable and records the status', async () => {
    globalThis.fetch = (async () => jsonResponse({}, 503)) as typeof fetch;
    const provider = new DeepSeekProvider(deepseekConfig());

    const error = await provider.analyze(analyzeInput(), AbortSignal.timeout(4_000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, status: 503 });
  });

  it('does not leak the upstream body in the error message', async () => {
    globalThis.fetch = (async () =>
      new Response('Authorization: Bearer test-key rejected; prompt was: 猫在拆家', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    const provider = new DeepSeekProvider(deepseekConfig());

    const error = await provider.analyze(analyzeInput(), AbortSignal.timeout(4_000)).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('test-key');
    expect((error as Error).message).not.toContain('猫在拆家');
  });

  it('parses a streamed reply split across SSE frames', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"这猫"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"又拆家"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch;

    const provider = new DeepSeekProvider(deepseekConfig());
    const parts: string[] = [];
    for await (const delta of provider.streamChat(chatInput(), AbortSignal.timeout(4_000))) {
      parts.push(delta);
    }
    expect(parts.join('')).toBe('这猫又拆家');
  });

  it('surfaces an in-stream error frame as an upstream error', async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"boom"}}\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch;

    const provider = new DeepSeekProvider(deepseekConfig());
    const consume = async (): Promise<void> => {
      for await (const _delta of provider.streamChat(chatInput(), AbortSignal.timeout(4_000))) {
        // Drain the stream.
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('rejects a reply that is not the expected JSON', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: '喵喵今天不想干活' } }] })) as typeof fetch;
    const provider = new DeepSeekProvider(deepseekConfig());

    await expect(provider.analyze(analyzeInput(), AbortSignal.timeout(4_000))).rejects.toMatchObject({
      code: 'UPSTREAM_PROTOCOL',
    });
  });
});
