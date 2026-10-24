/*
 * Thin wrapper over extension/shared/text-core.js, plus the few helpers that
 * genuinely need Node.
 *
 * The clamping and sanitising helpers moved to the shared file because the
 * BYOK prompt path needs them in the browser. Keeping a second copy here would
 * let the client and server send subtly different prompts.
 *
 * Server-only: hashShort (node:crypto, for device/idempotency keys that never
 * leave this process), isAbortError and delay.
 */
import { createHash } from 'node:crypto';
import '../../../extension/shared/text-core.js';

interface TextCoreApi {
  clampText(value: unknown, maxLength: number): string;
  sanitizeUntrusted(value: unknown, maxLength: number): string;
  dedupeStrings(values: unknown[], maxItems: number): string[];
  normalizeForMatch(value: string): string;
  bigrams(value: string): Set<string>;
  overlapCount(a: Set<string>, b: Set<string>): number;
  seed(value: string): number;
}

const core = (globalThis as unknown as { SmText: TextCoreApi }).SmText;
if (!core) {
  throw new Error('extension/shared/text-core.js did not install globalThis.SmText');
}

export function clampText(value: unknown, maxLength: number): string {
  return core.clampText(value, maxLength);
}

export function sanitizeUntrusted(value: unknown, maxLength: number): string {
  return core.sanitizeUntrusted(value, maxLength);
}

export function dedupeStrings(values: unknown[], maxItems: number): string[] {
  return core.dedupeStrings(values, maxItems);
}

export function normalizeForMatch(value: string): string {
  return core.normalizeForMatch(value);
}

export function bigrams(value: string): Set<string> {
  return core.bigrams(value);
}

export function overlapCount(a: Set<string>, b: Set<string>): number {
  return core.overlapCount(a, b);
}

export function hashShort(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
