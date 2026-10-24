import type { AppConfig } from '../config.js';
import type { AnalyzeInput, AnalyzeResult, ChatInput } from '../types.js';
import type { ModelProvider } from './ModelProvider.js';
import type { PromptMessage } from '../prompts/zh.js';
import { buildAnalyzeMessages, buildChatMessages } from '../prompts/zh.js';
import { clampText, dedupeStrings, isAbortError } from '../lib/text.js';
import { UpstreamError } from '../lib/errors.js';

type DeepSeekConfig = AppConfig['deepseek'];

interface OpenAIChoice {
  message?: { content?: unknown };
  delta?: { content?: unknown };
  finish_reason?: unknown;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  error?: { message?: unknown; type?: unknown };
}

/**
 * Official DeepSeek OpenAI-compatible API.
 * V4.1 Flash is `deepseek-flash`; images are only sent as user content parts,
 * thinking is disabled for latency, and analysis asks for JSON output.
 */
export class DeepSeekProvider implements ModelProvider {
  readonly name = 'deepseek';
  readonly visionModel: string;
  readonly chatModel: string;

  constructor(private readonly config: DeepSeekConfig) {
    if (!config.apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required when MODEL_PROVIDER=deepseek');
    }
    this.visionModel = config.visionModel;
    this.chatModel = config.chatModel;
  }

  async analyze(input: AnalyzeInput, callerSignal: AbortSignal): Promise<AnalyzeResult> {
    const messages = buildAnalyzeMessages(input, this.config.visionDetail);
    const body = {
      model: this.config.visionModel,
      messages,
      stream: false,
      temperature: 0.7,
      max_tokens: 700,
      response_format: { type: 'json_object' },
      ...this.thinkingParam(),
    };

    const response = await this.request(body, this.config.upstreamTimeoutMs, callerSignal);
    const json = await this.readJson(response, callerSignal);
    if (json.error) {
      throw new UpstreamError('UPSTREAM_ERROR', '模型服务返回错误', true);
    }
    const content = extractContent(json);
    if (!content) {
      throw new UpstreamError('UPSTREAM_PROTOCOL', '模型没有返回内容');
    }
    const parsed = parseJsonLoose(content);
    return normalizeAnalyzePayload(parsed);
  }

  async *streamChat(input: ChatInput, callerSignal: AbortSignal): AsyncIterable<string> {
    const messages = buildChatMessages(input);
    const body = {
      model: this.config.chatModel,
      messages,
      stream: true,
      temperature: 0.92,
      max_tokens: 220,
      ...this.thinkingParam(),
    };

    const response = await this.request(body, this.config.chatTimeoutMs, callerSignal);
    const streamSignal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(this.config.chatTimeoutMs),
    ]);
    const reader = response.body?.getReader();
    if (!reader) throw new UpstreamError('UPSTREAM_PROTOCOL', '模型流式响应为空');

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          const delta = parseSseDataLine(rawLine);
          if (delta === DONE) return;
          if (delta) yield delta;
        }
      }

      // A final event may arrive without a trailing newline.
      const tail = parseSseDataLine(buffer.replace(/\r$/, ''));
      if (tail === DONE) return;
      if (tail) yield tail;
    } catch (error) {
      if (callerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error instanceof UpstreamError) throw error;
      if (streamSignal.aborted) throw new UpstreamError('UPSTREAM_TIMEOUT', '模型流式响应超时');
      if (isAbortError(error)) throw new UpstreamError('UPSTREAM_TIMEOUT', '模型流式响应超时');
      throw new UpstreamError('UPSTREAM_ERROR', '模型流式响应中断');
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Reader may already be closed.
      }
      reader.releaseLock();
    }
  }

  private thinkingParam(): Record<string, unknown> {
    return this.config.thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {};
  }

  private async request(
    body: Record<string, unknown>,
    timeoutMs: number,
    callerSignal: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([callerSignal, timeoutSignal]);
    const streaming = body.stream === true;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: streaming ? 'text/event-stream' : 'application/json',
          'user-agent': 'video-buddy/0.1',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (callerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timeoutSignal.aborted || isAbortError(error)) {
        throw new UpstreamError('UPSTREAM_TIMEOUT', '模型服务响应超时');
      }
      throw new UpstreamError('UPSTREAM_ERROR', '无法连接模型服务');
    }

    if (!response.ok) {
      // Never include the response body: it could echo prompts or images.
      if (response.status === 401 || response.status === 403) {
        // A bad key is a configuration problem, not a transient outage. It must
        // surface as a distinct code so the extension stops retrying silently.
        throw new UpstreamError('UPSTREAM_AUTH', '模型服务拒绝了访问令牌，检查 DEEPSEEK_API_KEY', false, response.status);
      }
      const retryable = response.status >= 500 || response.status === 429;
      throw new UpstreamError(
        'UPSTREAM_ERROR',
        `模型服务返回 HTTP ${response.status}`,
        retryable,
        response.status,
      );
    }
    return response;
  }

  private async readJson(response: Response, callerSignal: AbortSignal): Promise<OpenAIResponse> {
    try {
      return (await response.json()) as OpenAIResponse;
    } catch (error) {
      if (callerSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (isAbortError(error)) {
        throw new UpstreamError('UPSTREAM_TIMEOUT', '读取模型响应超时');
      }
      throw new UpstreamError('UPSTREAM_PROTOCOL', '模型响应不是合法 JSON');
    }
  }
}

const DONE = Symbol('sse-done');

function parseSseDataLine(line: string): string | typeof DONE | null {
  if (!line || line.startsWith(':') || !line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return DONE;

  let event: OpenAIResponse;
  try {
    event = JSON.parse(data) as OpenAIResponse;
  } catch {
    return null;
  }
  if (event.error) {
    throw new UpstreamError('UPSTREAM_ERROR', '模型服务在流式响应中报错', true);
  }
  const content = event.choices?.[0]?.delta?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function extractContent(json: OpenAIResponse): string {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function parseJsonLoose(text: string): unknown {
  let value = text.trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new UpstreamError('UPSTREAM_PROTOCOL', '模型输出不是 JSON');
  }
  try {
    return JSON.parse(value.slice(start, end + 1)) as unknown;
  } catch {
    throw new UpstreamError('UPSTREAM_PROTOCOL', '模型输出 JSON 解析失败');
  }
}

function normalizeAnalyzePayload(parsed: unknown): AnalyzeResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new UpstreamError('UPSTREAM_PROTOCOL', '模型输出结构不正确');
  }
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? clampText(obj.summary, 100) : '';
  const reaction = typeof obj.reaction === 'string' ? clampText(obj.reaction, 100) : '';
  if (!summary && !reaction) {
    throw new UpstreamError('UPSTREAM_PROTOCOL', '模型输出缺少摘要与反应');
  }

  const rawKeywords = Array.isArray(obj.keywords) ? obj.keywords : [];
  const keywords = dedupeStrings(rawKeywords, 5);
  const mood = typeof obj.mood === 'string' ? clampText(obj.mood, 20) : '其他';
  const risk = obj.risk === 'blocked' ? 'blocked' : 'ok';
  const memeUsed = typeof obj.memeUsed === 'string' ? clampText(obj.memeUsed, 40) : null;
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0.6;

  return {
    summary,
    keywords,
    mood: mood || '其他',
    isAd: obj.isAd === true,
    isLive: obj.isLive === true,
    risk,
    reaction,
    memeUsed,
    confidence,
  };
}

export type { PromptMessage };
