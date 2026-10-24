import { existsSync } from 'node:fs';

export type ModelProviderName = 'mock' | 'deepseek';
export type ThinkingMode = 'enabled' | 'disabled';

export interface RateLimitConfig {
  analyzePerMinute: number;
  analyzePerHour: number;
  analyzePerDay: number;
  chatPerMinute: number;
  chatPerDay: number;
  visionConcurrency: number;
  totalConcurrency: number;
}

export interface AppConfig {
  version: string;
  port: number;
  host: string;
  appToken: string;
  logLevel: string;
  provider: ModelProviderName;
  deepseek: {
    apiKey: string;
    baseUrl: string;
    visionModel: string;
    chatModel: string;
    thinking: ThinkingMode;
    visionDetail: string;
    upstreamTimeoutMs: number;
    analyzeTimeoutMs: number;
    chatTimeoutMs: number;
  };
  mock: {
    delayMs: number;
    chunkDelayMs: number;
  };
  trends: {
    url: string;
    ttlMs: number;
    snapshotPath: string | null;
  };
  rateLimits: RateLimitConfig;
  bodyLimitBytes: number;
  idempotencyTtlMs: number;
}

/** Load `.env` once at process start. Missing file is fine. */
export function loadEnvFile(path = '.env'): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    console.warn(`[config] failed to load ${path}:`, (error as Error).message);
  }
}

/**
 * `.env.local` wins over `.env` (used for secrets and for switching provider
 * without touching the shared `.env`). `process.loadEnvFile` never overwrites
 * a variable that is already set, so loading the override file first is what
 * gives it precedence.
 */
export function loadEnvFiles(paths: string[] = ['.env.local', '.env']): void {
  for (const path of paths) loadEnvFile(path);
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(`[config] ignoring invalid ${key}=${raw}`);
    return fallback;
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider: ModelProviderName = env.MODEL_PROVIDER === 'deepseek' ? 'deepseek' : 'mock';
  const thinking: ThinkingMode = env.DEEPSEEK_THINKING === 'enabled' ? 'enabled' : 'disabled';
  const detail = str(env, 'VISION_DETAIL', 'high');
  const visionDetail = ['low', 'high', 'original', 'auto'].includes(detail) ? detail : 'high';

  return {
    version: '0.1.0',
    port: int(env, 'PORT', 8787, 1, 65535),
    host: str(env, 'HOST', '0.0.0.0'),
    appToken: str(env, 'APP_TOKEN', 'dev-token'),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    provider,
    deepseek: {
      apiKey: str(env, 'DEEPSEEK_API_KEY', ''),
      baseUrl: str(env, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
      visionModel: str(env, 'MODEL_VISION', 'deepseek-flash'),
      chatModel: str(env, 'MODEL_CHAT', 'deepseek-flash'),
      thinking,
      visionDetail,
      upstreamTimeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', 10_000, 1_000, 120_000),
      analyzeTimeoutMs: int(env, 'ANALYZE_TIMEOUT_MS', 12_000, 1_000, 120_000),
      chatTimeoutMs: int(env, 'CHAT_TIMEOUT_MS', 60_000, 5_000, 300_000),
    },
    mock: {
      delayMs: int(env, 'MOCK_DELAY_MS', 250, 0, 30_000),
      chunkDelayMs: int(env, 'MOCK_CHUNK_DELAY_MS', 12, 0, 1_000),
    },
    trends: {
      url: str(env, 'TREND_URL', 'https://60s.lzw.me/?type=douyin'),
      ttlMs: int(env, 'TREND_TTL_MS', 45 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000),
      snapshotPath: env.TREND_SNAPSHOT_PATH?.trim() || null,
    },
    rateLimits: {
      analyzePerMinute: int(env, 'RATE_ANALYZE_PER_MINUTE', 6, 1, 10_000),
      analyzePerHour: int(env, 'RATE_ANALYZE_PER_HOUR', 60, 1, 100_000),
      analyzePerDay: int(env, 'RATE_ANALYZE_PER_DAY', 300, 1, 1_000_000),
      chatPerMinute: int(env, 'RATE_CHAT_PER_MINUTE', 20, 1, 10_000),
      chatPerDay: int(env, 'RATE_CHAT_PER_DAY', 500, 1, 1_000_000),
      visionConcurrency: int(env, 'VISION_CONCURRENCY', 4, 1, 64),
      totalConcurrency: int(env, 'TOTAL_CONCURRENCY', 8, 1, 128),
    },
    bodyLimitBytes: int(env, 'BODY_LIMIT_BYTES', 1_572_864, 16_384, 8 * 1024 * 1024),
    idempotencyTtlMs: int(env, 'IDEMPOTENCY_TTL_MS', 10 * 60 * 1000, 1_000, 60 * 60 * 1000),
  };
}
