import { createHash } from 'node:crypto';

/** Collapse control characters and whitespace, then hard-truncate. */
export function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trimEnd();
}

/**
 * Screen text is untrusted data. Strip angle brackets so it cannot escape the
 * <ocr> delimiters in prompts, and cap the length.
 */
export function sanitizeUntrusted(value: unknown, maxLength: number): string {
  return clampText(value, maxLength).replace(/</g, '‹').replace(/>/g, '›');
}

export function dedupeStrings(values: unknown[], maxItems: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = clampText(value, 40);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Lowercase, keep CJK + letters + digits only. */
export function normalizeForMatch(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Character bigrams over normalized CJK/alphanumeric text. */
export function bigrams(value: string): Set<string> {
  const normalized = normalizeForMatch(value);
  const grams = new Set<string>();
  const chars = Array.from(normalized);
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

export function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) {
    if (large.has(gram)) count += 1;
  }
  return count;
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
