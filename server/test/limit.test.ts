import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(
  fileURLToPath(new URL('../../extension/shared/core.js', import.meta.url)),
  'utf8',
);
const context = { console, URL, Number, Math, String, Object, Array, Uint8Array, Date };
vm.createContext(context);
vm.runInContext(source, context);

interface LimitSnapshot {
  disabled: boolean;
  budgetMs: number;
  usedMs: number;
  inCooldown: boolean;
  cooldownLeftMs: number;
  overBudget: boolean;
}

interface BuddyApi {
  SETTINGS_VERSION: number;
  DEFAULTS: Record<string, any>;
  LIMIT_MINUTES_MIN: number;
  LIMIT_MINUTES_MAX: number;
  LIMIT_COOLDOWN_MIN: number;
  LIMIT_COOLDOWN_MAX: number;
  LIMIT_CLOSE_MIN: number;
  LIMIT_CLOSE_MAX: number;
  NUDGE_LIMIT_MIN: number;
  NUDGE_LIMIT_MAX: number;
  normalizeSettings(raw: unknown): Record<string, any>;
  limitBudgetMs(settings: unknown): number;
  limitCooldownMs(settings: unknown): number;
  limitCloseDelayMs(settings: unknown): number;
  normalizeLimitState(raw: unknown): { day: string; usedMs: number; shutAt: number };
  limitSnapshot(saved: unknown, nowMs: number, settings: unknown): LimitSnapshot;
  limitAfterShutdown(nowMs: number): { day: string; usedMs: number; shutAt: number };
  limitAfterNag(saved: unknown, nowMs: number): { day: string; usedMs: number; shutAt: number };
  limitCredit(
    saved: unknown,
    deltaMs: number,
    nowMs: number,
    settings: unknown,
  ): {
    state: { day: string; usedMs: number; shutAt: number };
    over: boolean;
    inCooldown: boolean;
    usedMs: number;
    disabled: boolean;
  };
  pickLimitLine(kind: string, recent?: unknown): string;
  LIMIT_LINES: { over: string[]; back: string[]; nag: string[] };
  dayKey(nowMs?: number): string;
}

const Buddy = (context as unknown as { Buddy: BuddyApi }).Buddy;

// The limiter ships off for a fresh install, but every case in this file is
// about the limiter itself, so it is switched on explicitly rather than
// resting on the default.
const settings = Buddy.normalizeSettings({ limitEnabled: true });
const MINUTE = 60_000;

describe('limit settings', () => {
  it('defaults to 30 minutes with a 10 minute cooldown and a 5s warning', () => {
    expect(Buddy.limitBudgetMs(settings)).toBe(30 * MINUTE);
    expect(Buddy.limitCooldownMs(settings)).toBe(10 * MINUTE);
    expect(Buddy.limitCloseDelayMs(settings)).toBe(5000);
  });

  it('clamps absurd input instead of trusting it', () => {
    // Deliberately still allows 1 minute: this knob makes no requests, and a
    // 1-minute budget is how the limiter is tested without waiting half an hour.
    const tiny = Buddy.normalizeSettings({ limitMinutes: 0 });
    expect(tiny.limitMinutes).toBe(Buddy.LIMIT_MINUTES_MIN);
    expect(Buddy.normalizeSettings({ limitMinutes: 1 }).limitMinutes).toBe(1);
    const huge = Buddy.normalizeSettings({ limitMinutes: 100_000 });
    expect(huge.limitMinutes).toBe(Buddy.LIMIT_MINUTES_MAX);
    const negative = Buddy.normalizeSettings({ limitCooldownMinutes: -5 });
    expect(negative.limitCooldownMinutes).toBe(0);
    const garbage = Buddy.normalizeSettings({ limitMinutes: 'abc' });
    expect(garbage.limitMinutes).toBe(30);
    const longCooldown = Buddy.normalizeSettings({ limitCooldownMinutes: 99_999 });
    expect(longCooldown.limitCooldownMinutes).toBe(Buddy.LIMIT_COOLDOWN_MAX);
  });

  it('clamps the close delay to the range the popup offers', () => {
    // The popup slider stops at 30s; core used to allow 60, so a hand-edited
    // value could leave the tab open twice as long with no UI to change it.
    expect(Buddy.normalizeSettings({ limitCloseSeconds: 999 }).limitCloseSeconds).toBe(Buddy.LIMIT_CLOSE_MAX);
    expect(Buddy.normalizeSettings({ limitCloseSeconds: -1 }).limitCloseSeconds).toBe(0);
    expect(Buddy.LIMIT_CLOSE_MAX).toBe(30);
  });

  it('keeps the nudge cap inside the range the popup offers', () => {
    // The cap is a setting because tolerance varies; the floor still leaves
    // room to answer between nags, and the ceiling is five minutes of nagging.
    expect(Buddy.normalizeSettings({}).nudgeLimitCount).toBe(10);
    expect(Buddy.normalizeSettings({ nudgeLimitCount: 1 }).nudgeLimitCount).toBe(Buddy.NUDGE_LIMIT_MIN);
    expect(Buddy.normalizeSettings({ nudgeLimitCount: 999 }).nudgeLimitCount).toBe(Buddy.NUDGE_LIMIT_MAX);
    expect(Buddy.normalizeSettings({ nudgeLimitCount: 'abc' }).nudgeLimitCount).toBe(10);
    expect(Buddy.NUDGE_LIMIT_MIN).toBe(3);
    expect(Buddy.NUDGE_LIMIT_MAX).toBe(60);
  });

  it('ships the limiter on for a fresh install', () => {
    // The product default is on: the first conversation reports the budget,
    // and the user can still turn it off explicitly.
    expect(Buddy.DEFAULTS.limitEnabled).toBe(true);
    expect(Buddy.normalizeSettings({}).limitEnabled).toBe(true);
    const fresh = Buddy.limitSnapshot(null, Date.now(), Buddy.normalizeSettings({}));
    expect(fresh.disabled).toBe(false);
    expect(fresh.overBudget).toBe(false);
    expect(fresh.budgetMs).toBe(30 * 60 * 1000);
  });

  it('keeps the limiter on for settings saved before the field existed', () => {
    // An instalment that predates limitEnabled has other keys but no such key.
    // Falling through to the new default would silently switch off a feature
    // the user was already relying on.
    const legacy = Buddy.normalizeSettings({
      serverUrl: 'http://127.0.0.1:8787',
      dwellSeconds: 10,
      ballSize: 60,
    });
    expect(legacy.limitEnabled).toBe(true);

    // An explicit value always wins, in both directions.
    expect(Buddy.normalizeSettings({ dwellSeconds: 10, limitEnabled: false }).limitEnabled).toBe(false);
    expect(Buddy.normalizeSettings({ limitEnabled: true }).limitEnabled).toBe(true);
  });

  it('stamps the stored settings so a later release can migrate them', () => {
    // Absent on anything written before the field existed, so 1 is the floor.
    expect(Buddy.normalizeSettings({}).settingsVersion).toBe(Buddy.SETTINGS_VERSION);
    expect(Buddy.normalizeSettings({ settingsVersion: 1 }).settingsVersion).toBe(1);
    // A stamp from a newer build is preserved rather than clamped: a downgrade
    // must not destroy the fact that the stored data is ahead of this code.
    expect(Buddy.normalizeSettings({ settingsVersion: 999 }).settingsVersion).toBe(999);
    // Junk falls back to the current version instead of poisoning the stamp.
    expect(Buddy.normalizeSettings({ settingsVersion: 'abc' }).settingsVersion).toBe(Buddy.SETTINGS_VERSION);
  });

  it('treats the limiter as off when disabled or the budget is zero', () => {
    const off = Buddy.normalizeSettings({ limitEnabled: false });
    expect(Buddy.limitBudgetMs(off)).toBe(0);
    expect(Buddy.limitSnapshot(null, Date.now(), off).disabled).toBe(true);
  });
});

describe('limitSnapshot', () => {
  const now = Date.UTC(2026, 9, 24, 4, 0, 0);

  it('lets a fresh day through with the full budget', () => {
    const snap = Buddy.limitSnapshot(null, now, settings);
    expect(snap).toMatchObject({ usedMs: 0, inCooldown: false, overBudget: false });
  });

  it('carries the used time up to, but never past, the budget', () => {
    const half = Buddy.limitSnapshot({ day: Buddy.dayKey(now), usedMs: 15 * MINUTE }, now, settings);
    expect(half.usedMs).toBe(15 * MINUTE);
    expect(half.overBudget).toBe(false);

    const over = Buddy.limitSnapshot({ day: Buddy.dayKey(now), usedMs: 99 * MINUTE }, now, settings);
    expect(over.usedMs).toBe(30 * MINUTE);
    expect(over.overBudget).toBe(true);
  });

  it('is in cooldown right after a shutdown, with nothing counted yet', () => {
    const snap = Buddy.limitSnapshot(Buddy.limitAfterShutdown(now), now + MINUTE, settings);
    expect(snap.inCooldown).toBe(true);
    expect(snap.cooldownLeftMs).toBe(9 * MINUTE);
    // Crucially not over budget: the user gets a warning, then a fresh start,
    // rather than being closed twice for the same spending.
    expect(snap.overBudget).toBe(false);
  });

  it('leaves the cooldown exactly when it lapses', () => {
    const shut = Buddy.limitAfterShutdown(now);
    expect(Buddy.limitSnapshot(shut, now + 10 * MINUTE - 1, settings).inCooldown).toBe(true);
    expect(Buddy.limitSnapshot(shut, now + 10 * MINUTE, settings).inCooldown).toBe(false);
  });

  it('keeps spent time after a nudge shutdown instead of farming a new budget', () => {
    // A nag shutdown is a cooldown, not a reset: when it ends, the user gets
    // back the time they had already spent, not a fresh allowance.
    const nag = Buddy.limitAfterNag({ day: Buddy.dayKey(now), usedMs: 10 * MINUTE }, now);
    const during = Buddy.limitSnapshot(nag, now + MINUTE, settings);
    expect(during.inCooldown).toBe(true);
    const after = Buddy.limitSnapshot(nag, now + 10 * MINUTE, settings);
    expect(after.inCooldown).toBe(false);
    expect(after.usedMs).toBe(10 * MINUTE);
    expect(after.overBudget).toBe(false);
  });

  it('forgets yesterday', () => {
    const yesterday = Buddy.limitSnapshot(
      { day: '2020-01-01', usedMs: 30 * MINUTE },
      now,
      settings,
    );
    expect(yesterday.overBudget).toBe(false);
    expect(yesterday.usedMs).toBe(0);
  });

  it('survives a corrupted saved value', () => {
    for (const raw of [null, undefined, 'nonsense', 42, { usedMs: 'x', day: 7, shutAt: {} }]) {
      const snap = Buddy.limitSnapshot(raw, now, settings);
      expect(snap.usedMs).toBe(0);
      expect(snap.inCooldown).toBe(false);
    }
  });

  it('ignores a shutdown timestamp from the future', () => {
    // A clock change must not freeze the page in cooldown forever.
    const snap = Buddy.limitSnapshot({ shutAt: now + 10 * 24 * 60 * MINUTE }, now, settings);
    expect(snap.inCooldown).toBe(false);
  });
});

describe('limitCredit (shared across tabs)', () => {
  const now = Date.UTC(2026, 9, 24, 4, 0, 0);

  it('accumulates one shared total across successive calls', () => {
    let state: unknown = null;
    let used = 0;
    // Two tabs, interleaved: each delta must add to the same running total.
    for (const delta of [4000, 6000, 5000, 5000]) {
      const r = Buddy.limitCredit(state, delta, now, settings);
      state = r.state;
      used = r.usedMs;
    }
    expect(used).toBe(20_000);
    expect((state as { usedMs: number }).usedMs).toBe(20_000);
  });

  it('flips to over exactly at the budget, not a tick late', () => {
    const almost = Buddy.limitCredit({ day: Buddy.dayKey(now), usedMs: 30 * MINUTE - 1000 }, 500, now, settings);
    expect(almost.over).toBe(false);
    const exact = Buddy.limitCredit(almost.state, 500, now, settings);
    expect(exact.over).toBe(true);
    expect(exact.usedMs).toBe(30 * MINUTE);
  });

  it('stamps the shutdown itself when the budget runs out', () => {
    const r = Buddy.limitCredit({ day: Buddy.dayKey(now), usedMs: 30 * MINUTE }, 1000, now + 5000, settings);
    expect(r.over).toBe(true);
    // usedMs resets and the cooldown clock starts; the page never has to
    // write it, which is what makes concurrent tabs safe.
    expect(r.state).toMatchObject({ usedMs: 0, shutAt: now + 5000 });
  });

  it('charges nothing and does not extend the cooldown while shut', () => {
    const shut = Buddy.limitAfterShutdown(now);
    const r = Buddy.limitCredit(shut, 60_000, now + MINUTE, settings);
    expect(r.inCooldown).toBe(true);
    expect(r.over).toBe(false);
    // The stamp is returned untouched: extending it on every peek would turn a
    // 10-minute cooldown into an indefinite lockout.
    expect(r.state).toEqual(shut);
  });

  it('ignores junk deltas instead of poisoning the total', () => {
    for (const delta of [0, -5000, NaN, Infinity, undefined, 'abc']) {
      const r = Buddy.limitCredit({ day: Buddy.dayKey(now), usedMs: 5000 }, delta as number, now, settings);
      expect(r.usedMs).toBe(5000);
    }
  });

  it('does nothing at all when the limiter is off', () => {
    const off = Buddy.normalizeSettings({ limitEnabled: false });
    const r = Buddy.limitCredit({ day: Buddy.dayKey(now), usedMs: 1000 }, 60_000, now, off);
    expect(r.disabled).toBe(true);
    expect(r.over).toBe(false);
    expect(r.state.usedMs).toBe(1000);
  });
});

describe('limit lines', () => {
  it('every line ends with 喵 and none of them mention a duration', () => {
    for (const kind of ['over', 'back', 'nag'] as const) {
      expect(Buddy.LIMIT_LINES[kind].length).toBeGreaterThan(3);
      for (const line of Buddy.LIMIT_LINES[kind]) {
        expect(line, line).toMatch(/喵[。！？!?]*$/);
        expect(line, line).not.toMatch(/\d+\s*(秒|分钟)|毫秒/);
      }
    }
    // The cap line quotes the setting, so the pool must leave a slot for it.
    for (const line of Buddy.LIMIT_LINES.nag) expect(line).toContain('{count}');
  });

  it('avoids lines already used', () => {
    const first = Buddy.pickLimitLine('over', []);
    const seen = Buddy.LIMIT_LINES.over.slice(0, Buddy.LIMIT_LINES.over.length - 1);
    const second = Buddy.pickLimitLine('over', seen);
    expect(first).toBeTruthy();
    expect(seen).not.toContain(second);
  });

  it('falls back to the whole pool once every line has been used', () => {
    const line = Buddy.pickLimitLine('back', Buddy.LIMIT_LINES.back);
    expect(Buddy.LIMIT_LINES.back).toContain(line);
  });

  it('falls back to the over pool for an unknown kind', () => {
    expect(Buddy.LIMIT_LINES.over).toContain(Buddy.pickLimitLine('nonsense', []));
  });
});

describe('limitAfterNag', () => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);

  it('stamps the cooldown without refunding the day', () => {
    const saved = { day: Buddy.dayKey(now), usedMs: 12 * MINUTE, shutAt: 0 };
    const nag = Buddy.limitAfterNag(saved, now);
    expect(nag.shutAt).toBe(now);
    expect(nag.usedMs).toBe(12 * MINUTE);
    expect(nag.day).toBe(Buddy.dayKey(now));
    // A budget shutdown is the one that resets, and it still does.
    expect(Buddy.limitAfterShutdown(now).usedMs).toBe(0);
  });

  it('drops a previous day total rather than reviving it', () => {
    const nag = Buddy.limitAfterNag({ day: '2026-10-24', usedMs: 20 * MINUTE, shutAt: 0 }, now);
    expect(nag.usedMs).toBe(0);
  });

  it('survives a corrupted ledger', () => {
    for (const raw of [null, undefined, 'nope', { usedMs: 'x', day: 7 }]) {
      const nag = Buddy.limitAfterNag(raw, now);
      expect(nag.usedMs).toBe(0);
      expect(nag.shutAt).toBe(now);
    }
  });
});

describe('background wiring', () => {
  const background = readFileSync(
    fileURLToPath(new URL('../../extension/background.js', import.meta.url)),
    'utf8',
  );

  it('stamps a nag shutdown with the reason the page sent', () => {
    // The worker is the only writer of the ledger, so the distinction has to
    // survive the message hop. Losing it would silently turn every nag
    // shutdown into a full refund.
    expect(background).toMatch(/stampShutdown\(message\.reason === 'nag' \? 'nag' : 'over'/);
    const stamp = background.slice(background.indexOf('function stampShutdown'));
    const body = stamp.slice(0, stamp.indexOf('// Keep the cached copy honest'));
    expect(body).toContain('Buddy.limitAfterNag');
    expect(body).toContain('Buddy.limitAfterShutdown');
  });

  it('is still idempotent, so two tabs cannot extend the cooldown', () => {
    const stamp = background.slice(background.indexOf('function stampShutdown'));
    const body = stamp.slice(0, stamp.indexOf('// Keep the cached copy honest'));
    expect(body).toContain('snap.inCooldown');
    expect(body.indexOf('snap.inCooldown')).toBeLessThan(body.indexOf('limitAfterNag'));
  });
});

describe('dayKey', () => {
  it('formats local dates and changes at midnight', () => {
    expect(Buddy.dayKey(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02');
    expect(Buddy.dayKey(new Date(2026, 0, 3, 0, 0).getTime())).toBe('2026-01-03');
  });
});
