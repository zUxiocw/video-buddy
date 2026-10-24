export interface WindowRule {
  name: string;
  limit: number;
  windowMs: number;
}

export type RateDecision =
  | { allowed: true }
  | { allowed: false; rule: WindowRule; retryAfterMs: number };

/**
 * In-memory sliding-window limiter keyed by device+IP hash.
 * Personal-scale only; a restart clears counters.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxKeys: number;

  constructor(maxKeys = 10_000) {
    this.maxKeys = maxKeys;
  }

  take(key: string, rules: readonly WindowRule[], now = Date.now()): RateDecision {
    const maxWindow = Math.max(...rules.map((rule) => rule.windowMs), 0);
    const history = this.hits.get(key) ?? [];
    const fresh = history.filter((timestamp) => now - timestamp < maxWindow);

    for (const rule of rules) {
      const inWindow = fresh.filter((timestamp) => now - timestamp < rule.windowMs);
      if (inWindow.length >= rule.limit) {
        const oldest = inWindow[0] ?? now;
        const retryAfterMs = Math.max(0, rule.windowMs - (now - oldest));
        this.hits.set(key, fresh);
        return { allowed: false, rule, retryAfterMs };
      }
    }

    fresh.push(now);
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      this.hits.clear();
    }
    this.hits.set(key, fresh);
    return { allowed: true };
  }

  reset(): void {
    this.hits.clear();
  }
}
