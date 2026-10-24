import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rateLimit.js';
import { CountingSemaphore } from '../src/lib/semaphore.js';
import { IdempotencyCache } from '../src/lib/idempotency.js';

describe('RateLimiter', () => {
  const rules = [{ name: 'minute', limit: 2, windowMs: 1_000 }];

  it('allows up to the limit within a sliding window', () => {
    const limiter = new RateLimiter();
    expect(limiter.take('key', rules, 0).allowed).toBe(true);
    expect(limiter.take('key', rules, 100).allowed).toBe(true);
    const denied = limiter.take('key', rules, 200);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.rule.name).toBe('minute');
      expect(denied.retryAfterMs).toBe(800);
    }
    expect(limiter.take('key', rules, 1_100).allowed).toBe(true);
  });

  it('applies the strictest of multiple windows', () => {
    const limiter = new RateLimiter();
    const both = [
      { name: 'minute', limit: 10, windowMs: 1_000 },
      { name: 'day', limit: 1, windowMs: 86_400_000 },
    ];
    expect(limiter.take('other', both, 0).allowed).toBe(true);
    const denied = limiter.take('other', both, 10);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.rule.name).toBe('day');
  });

  it('tracks keys independently', () => {
    const limiter = new RateLimiter();
    expect(limiter.take('a', rules, 0).allowed).toBe(true);
    expect(limiter.take('a', rules, 1).allowed).toBe(true);
    expect(limiter.take('a', rules, 2).allowed).toBe(false);
    expect(limiter.take('b', rules, 2).allowed).toBe(true);
  });
});

describe('CountingSemaphore', () => {
  it('caps concurrency and releases idempotently', () => {
    const semaphore = new CountingSemaphore(2);
    const first = semaphore.tryAcquire();
    const second = semaphore.tryAcquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(semaphore.tryAcquire()).toBeNull();
    first!();
    first!();
    expect(semaphore.inUse).toBe(1);
    const third = semaphore.tryAcquire();
    expect(third).not.toBeNull();
    third!();
    second!();
    expect(semaphore.inUse).toBe(0);
  });
});

describe('IdempotencyCache', () => {
  it('expires entries after the TTL', () => {
    const cache = new IdempotencyCache<string>(100);
    cache.set('k', 'v', 0);
    expect(cache.get('k', 50)).toBe('v');
    expect(cache.get('k', 101)).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const cache = new IdempotencyCache<string>(10_000, 2);
    cache.set('a', '1', 0);
    cache.set('b', '2', 0);
    cache.set('c', '3', 0);
    expect(cache.get('a', 0)).toBeUndefined();
    expect(cache.get('b', 0)).toBe('2');
    expect(cache.get('c', 0)).toBe('3');
  });
});
