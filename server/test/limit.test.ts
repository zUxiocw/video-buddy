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
  normalizeSettings(raw: unknown): Record<string, any>;
  limitBudgetMs(settings: unknown): number;
  limitCooldownMs(settings: unknown): number;
  limitCloseDelayMs(settings: unknown): number;
  normalizeLimitState(raw: unknown): { day: string; usedMs: number; shutAt: number };
  limitSnapshot(saved: unknown, nowMs: number, settings: unknown): LimitSnapshot;
  limitAfterShutdown(nowMs: number): { day: string; usedMs: number; shutAt: number };
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
  LIMIT_LINES: { over: string[]; back: string[] };
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

  it('ships the limiter off for a fresh install', () => {
    // Closing a stranger's tab half an hour after they install is not a first
    // impression worth having, so the default is off and the popup offers it.
    expect(Buddy.DEFAULTS.limitEnabled).toBe(false);
    expect(Buddy.normalizeSettings({}).limitEnabled).toBe(false);
    const fresh = Buddy.limitSnapshot(null, Date.now(), Buddy.normalizeSettings({}));
    expect(fresh.disabled).toBe(true);
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
    for (const kind of ['over', 'back'] as const) {
      expect(Buddy.LIMIT_LINES[kind].length).toBeGreaterThan(3);
      for (const line of Buddy.LIMIT_LINES[kind]) {
        expect(line, line).toMatch(/喵[。！？!?]*$/);
        expect(line, line).not.toMatch(/\d+\s*(秒|分钟)|毫秒/);
      }
    }
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

describe('dayKey', () => {
  it('formats local dates and changes at midnight', () => {
    expect(Buddy.dayKey(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02');
    expect(Buddy.dayKey(new Date(2026, 0, 3, 0, 0).getTime())).toBe('2026-01-03');
  });
});
