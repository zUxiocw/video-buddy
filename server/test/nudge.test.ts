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

interface NudgeFlags {
  enabled?: boolean;
  proactive?: boolean;
  visible?: boolean;
  afterMs?: number;
}

interface NudgeState {
  lastUserAt?: number;
  active?: boolean;
  nextAt?: number;
}

interface NudgeMachine {
  isActive(): boolean;
  nextAt(): number;
  lastUserAt(): number;
  spoken(): number;
  isExhausted(): boolean;
  tick(): void;
  userSpoke(): void;
  restart(): void;
  stop(): void;
  release(): void;
}

interface MachineOptions {
  now(): number;
  enabled?(): boolean;
  proactive?(): boolean;
  visible?(): boolean;
  afterMs?(): number;
  cap?(): number;
  onSpeak?(): void;
  onStop?(): void;
  onExhausted?(): void;
  lastUserAt?: number;
}

interface NudgeApi {
  DEFAULTS: { limitMinutes: number; nudgeLimitCount: number; nudgeAfterMinutes: number };
  NUDGE_AFTER_MS: number;
  NUDGE_AFTER_MIN: number;
  NUDGE_AFTER_MAX: number;
  nudgeAfterMs(settings: unknown): number;
  NUDGE_GAP_MS: number;
  BUDGET_LEAD_MS: number;
  DWELL_MIN: number;
  NUDGE_LIMIT_MIN: number;
  NUDGE_LIMIT_MAX: number;
  NUDGE_LINES: string[];
  BUDGET_LINES: string[];
  LIMIT_LINES: Record<string, string[]>;
  pickNudgeLine(recent?: unknown): string;
  pickBudgetLine(minutes: unknown, recent?: unknown): string;
  pickLimitLine(kind: string, recent?: unknown): string;
  nudgeDue(lastUserAt: unknown, nowMs: unknown, afterMs?: number): boolean;
  nudgeStep(
    current: NudgeState,
    nowMs: number,
    flags: NudgeFlags,
  ): { active: boolean; nextAt: number; speak: boolean };
  createNudgeMachine(options: MachineOptions): NudgeMachine;
  normalizeSettings(raw: unknown): Record<string, any>;
  limitAfterNag(saved: unknown, nowMs: number): { day: string; usedMs: number; shutAt: number };
  limitAfterShutdown(nowMs: number): { day: string; usedMs: number; shutAt: number };
  dayKey(nowMs?: number): string;
}

const Buddy = (context as unknown as { Buddy: NudgeApi }).Buddy;
const MINUTE = 60_000;

/**
 * Drives the real machine with a fake clock, calling it exactly the way the
 * content script does: `tick()` every 400ms from the tracker, `userSpoke()` from
 * sendMessage(). Testing this object rather than a re-implementation is the
 * point of moving the lifecycle out of buddy.js.
 */
function harness(options: Partial<MachineOptions> = {}) {
  // A positive epoch, not 0: `lastUserAt <= 0` means "never spoken" to the
  // machine, so a fake clock parked at zero would never arm at all.
  let clock = 1_000_000;
  let speaks = 0;
  let stops = 0;
  let exhausted = 0;
  const flags = { enabled: true, proactive: true, visible: true };
  // Mirrors the page's `cap` getter: the limiter switch decides whether a cap
  // exists at all, the count decides where it sits.
  const cap = { enabled: false, count: 10 };

  const machine = Buddy.createNudgeMachine({
    now: () => clock,
    enabled: () => flags.enabled,
    proactive: () => flags.proactive,
    visible: () => flags.visible,
    cap: () => (cap.enabled ? cap.count : 0),
    onSpeak: () => { speaks += 1; },
    onStop: () => { stops += 1; },
    onExhausted: () => { exhausted += 1; },
    ...options,
  });

  /** Advance the fake clock the way the 400ms tracker tick would. */
  function advance(ms: number, stepMs = 400) {
    const target = clock + ms;
    while (clock < target) {
      clock = Math.min(clock + stepMs, target);
      machine.tick();
    }
  }

  return {
    machine,
    flags,
    cap,
    advance,
    speaks: () => speaks,
    stops: () => stops,
    exhausted: () => exhausted,
    now: () => clock,
  };
}

describe('silence nudge constants', () => {
  it('fixes the two intervals the site states', () => {
    expect(Buddy.NUDGE_AFTER_MS).toBe(5 * MINUTE);
    expect(Buddy.NUDGE_GAP_MS).toBe(5000);
  });

  it('keeps every nudge line inside the persona', () => {
    expect(Buddy.NUDGE_LINES.length).toBeGreaterThan(1);
    for (const line of Buddy.NUDGE_LINES) {
      expect(line.endsWith('喵'), line).toBe(true);
      // The same hard rule as the shutdown lines: the cat never talks about
      // how long anything has been watched.
      expect(line, line).not.toMatch(/\d|\b秒\b|\b分钟\b/);
    }
  });
});

describe('budget announcement lines', () => {
  it('reads the setting back and keeps the 喵 tail', () => {
    for (const line of Buddy.BUDGET_LINES) {
      expect(line).toContain('{minutes}');
      expect(line.endsWith('喵'), line).toBe(true);
    }
    expect(Buddy.pickBudgetLine(45)).toContain('45');
    expect(Buddy.pickBudgetLine(45)).not.toContain('{minutes}');
  });

  it('falls back to the default when the setting is garbage', () => {
    expect(Buddy.pickBudgetLine('nope')).toContain(String(Buddy.DEFAULTS.limitMinutes));
    expect(Buddy.pickBudgetLine(0)).toContain(String(Buddy.DEFAULTS.limitMinutes));
  });
});

describe('nudgeDue', () => {
  it('is false until the full five minutes have passed', () => {
    expect(Buddy.nudgeDue(1000, 1000 + Buddy.NUDGE_AFTER_MS - 1)).toBe(false);
    expect(Buddy.nudgeDue(1000, 1000 + Buddy.NUDGE_AFTER_MS)).toBe(true);
  });

  it('refuses to be armed by a missing or future timestamp', () => {
    // A clock that jumped backwards must not park the user in "quiet forever",
    // and an unset timestamp must not read as "quiet since forever".
    expect(Buddy.nudgeDue(undefined, 10 * MINUTE)).toBe(false);
    expect(Buddy.nudgeDue(0, 10 * MINUTE)).toBe(false);
    expect(Buddy.nudgeDue(20 * MINUTE, 10 * MINUTE)).toBe(false);
    expect(Buddy.nudgeDue('garbage', 10 * MINUTE)).toBe(false);
  });
});

describe('nudge timing setting', () => {
  it('defaults to five minutes and clamps to one through ten', () => {
    expect(Buddy.normalizeSettings({}).nudgeAfterMinutes).toBe(5);
    expect(Buddy.normalizeSettings({ nudgeAfterMinutes: 0 }).nudgeAfterMinutes).toBe(1);
    expect(Buddy.normalizeSettings({ nudgeAfterMinutes: 99 }).nudgeAfterMinutes).toBe(10);
    expect(Buddy.normalizeSettings({ nudgeAfterMinutes: 'abc' }).nudgeAfterMinutes).toBe(5);
    expect(Buddy.NUDGE_AFTER_MIN).toBe(1);
    expect(Buddy.NUDGE_AFTER_MAX).toBe(10);
    expect(Buddy.nudgeAfterMs({ nudgeAfterMinutes: 1 })).toBe(1 * MINUTE);
    expect(Buddy.nudgeAfterMs({ nudgeAfterMinutes: 10 })).toBe(10 * MINUTE);
  });

  it('honours a custom wait in nudgeDue and the machine', () => {
    expect(Buddy.nudgeDue(1000, 1000 + 2 * MINUTE - 1, 2 * MINUTE)).toBe(false);
    expect(Buddy.nudgeDue(1000, 1000 + 2 * MINUTE, 2 * MINUTE)).toBe(true);

    const h = harness({ afterMs: () => 2 * MINUTE });
    h.advance(2 * MINUTE - 1000);
    expect(h.speaks()).toBe(0);
    h.advance(1000);
    expect(h.speaks()).toBe(1);
  });
});

describe('nudge lifecycle', () => {
  it('stays quiet for five minutes, then speaks once per five seconds', () => {
    const h = harness();

    h.advance(Buddy.NUDGE_AFTER_MS - 1000);
    expect(h.speaks()).toBe(0);
    expect(h.machine.isActive()).toBe(false);

    // The 5-minute mark lands inside the next stretch of ticks.
    h.advance(2000);
    expect(h.speaks()).toBe(1);
    expect(h.machine.isActive()).toBe(true);

    // Nothing in the gap, then exactly one more at the gap boundary.
    h.advance(Buddy.NUDGE_GAP_MS - 1000);
    expect(h.speaks()).toBe(1);
    h.advance(1000);
    expect(h.speaks()).toBe(2);

    // And it keeps going — the brief is "一直说直到回话".
    h.advance(25_000);
    expect(h.speaks()).toBe(7);
    expect(h.stops()).toBe(0);
  });

  it('stops as soon as the user answers and restarts the silence clock', () => {
    const h = harness();
    h.advance(Buddy.NUDGE_AFTER_MS + 12_000);
    expect(h.speaks()).toBeGreaterThan(1);

    h.machine.userSpoke();
    expect(h.machine.isActive()).toBe(false);
    // The face goes back to greet, once, for the run that just ended.
    expect(h.stops()).toBe(1);

    const before = h.speaks();
    h.advance(Buddy.NUDGE_AFTER_MS - 5000);
    expect(h.speaks()).toBe(before);
    h.advance(6000);
    expect(h.speaks()).toBe(before + 1);
  });

  it('never speaks while either switch is off, and ends a run that is under way', () => {
    const h = harness();
    h.advance(Buddy.NUDGE_AFTER_MS + 1000);
    expect(h.machine.isActive()).toBe(true);

    // 主动搭话 off mid-run: stop immediately rather than nagging on.
    h.flags.proactive = false;
    h.advance(1000);
    expect(h.machine.isActive()).toBe(false);
    expect(h.stops()).toBe(1);

    const before = h.speaks();
    h.advance(Buddy.NUDGE_AFTER_MS * 2);
    expect(h.speaks()).toBe(before);

    // Turning it back on does not replay the missed nags in a burst.
    h.flags.proactive = true;
    h.advance(1000);
    expect(h.speaks()).toBe(before + 1);
  });

  it('does not talk to a background tab, and ends the run instead of queueing', () => {
    const h = harness();
    h.advance(Buddy.NUDGE_AFTER_MS + 1000);
    const before = h.speaks();
    expect(before).toBe(1);

    h.flags.visible = false;
    h.advance(400);
    expect(h.machine.isActive()).toBe(false);

    // A long time in the background must not come back as a backlog.
    h.advance(10 * MINUTE);
    expect(h.speaks()).toBe(before);

    h.flags.visible = true;
    h.advance(1000);
    expect(h.speaks()).toBe(before + 1);
  });

  it('stop() ends the run without restarting the silence clock', () => {
    // This is the shutdown / page-hidden path: the tab is going away or the
    // user is not there, so the nag starts again immediately on return.
    const h = harness();
    h.advance(Buddy.NUDGE_AFTER_MS + 1000);
    const spokenAt = h.now();
    h.machine.stop();
    expect(h.machine.isActive()).toBe(false);
    expect(h.machine.lastUserAt()).toBe(spokenAt - Buddy.NUDGE_AFTER_MS - 1000);

    const before = h.speaks();
    h.advance(1000);
    expect(h.speaks()).toBe(before + 1);
  });

  it('restart() resets the window the way a new conversation does', () => {
    const h = harness();
    h.advance(Buddy.NUDGE_AFTER_MS + 1000);
    h.machine.restart();
    expect(h.machine.isActive()).toBe(false);

    const before = h.speaks();
    h.advance(Buddy.NUDGE_AFTER_MS - 5000);
    expect(h.speaks()).toBe(before);
    h.advance(6000);
    expect(h.speaks()).toBe(before + 1);
  });

  it('recovers from a clock that jumped backwards', () => {
    let clock = 10 * MINUTE;
    const machine = Buddy.createNudgeMachine({
      now: () => clock,
      lastUserAt: 10 * MINUTE,
    });
    clock = 1000; // NTP correction, or a machine waking from sleep.
    machine.tick();
    expect(machine.isActive()).toBe(false);
    expect(machine.lastUserAt()).toBe(1000);
    clock = 1000 + Buddy.NUDGE_AFTER_MS;
    machine.tick();
    expect(machine.isActive()).toBe(true);
  });
});

describe('nudge cap (沉默催促 → 关页)', () => {
  it('defaults to ten and clamps to a range that leaves room to answer', () => {
    expect(Buddy.normalizeSettings({}).nudgeLimitCount).toBe(10);
    expect(Buddy.normalizeSettings({ nudgeLimitCount: 1 }).nudgeLimitCount).toBe(3);
    expect(Buddy.normalizeSettings({ nudgeLimitCount: 999 }).nudgeLimitCount).toBe(60);
    expect(Buddy.normalizeSettings({ nudgeLimitCount: 'abc' }).nudgeLimitCount).toBe(10);
    // A floor of 1 would go straight from the first nag to closing the tab,
    // with no gap for the user to answer in.
    expect(Buddy.NUDGE_LIMIT_MIN).toBeGreaterThanOrEqual(3);
  });

  it('counts the closing line as the last utterance, not an extra nag', () => {
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 3;

    // 5 minutes of silence to arm, then one utterance per gap.
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    expect(h.speaks()).toBe(1);
    expect(h.exhausted()).toBe(0);

    h.advance(Buddy.NUDGE_GAP_MS);
    expect(h.speaks()).toBe(2);
    expect(h.exhausted()).toBe(0);

    // The third utterance is the shutdown, so it is reported as exhausted and
    // never rendered as a nag line.
    h.advance(Buddy.NUDGE_GAP_MS);
    expect(h.speaks()).toBe(2);
    expect(h.exhausted()).toBe(1);
    expect(h.machine.spoken()).toBe(3);
    expect(h.machine.isExhausted()).toBe(true);
  });

  it('never fires a second shutdown for one streak', () => {
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 3;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    h.advance(Buddy.NUDGE_GAP_MS * 4);
    expect(h.exhausted()).toBe(1);
    expect(h.speaks()).toBe(2);
  });

  it('keeps the tracker frozen while the shutdown line is on screen', () => {
    // The tracker reads `isActive()` to decide whether dwell time and the
    // daily budget may accrue. If the cap cleared it, a video reaction could
    // fire on top of the closing bubble during the countdown.
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 3;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    // One gap plus a tick of slack: ticks land every 400ms while the deadline
    // is 5000ms away, so the boundary is not hit exactly.
    h.advance(Buddy.NUDGE_GAP_MS * 2 + 1000);
    expect(h.machine.isExhausted()).toBe(true);
    expect(h.machine.isActive()).toBe(true);

    // The page's shutdown path calls stop() from inside the callback; that must
    // not hand control back to the tracker either.
    h.machine.stop();
    expect(h.machine.isActive()).toBe(true);
    h.advance(30_000);
    expect(h.speaks()).toBe(2);
    expect(h.exhausted()).toBe(1);
  });

  it('does not grow the cap back when the tab is hidden and shown again', () => {
    // Hiding the tab is not answering the cat. If it reset the count, anyone
    // could switch tabs every few nags and never reach the cap.
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 4;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    expect(h.speaks()).toBe(1);

    h.flags.visible = false;
    h.advance(1000);
    expect(h.machine.isActive()).toBe(false);
    expect(h.machine.spoken()).toBe(1);
    h.flags.visible = true;
    h.advance(1000);
    expect(h.machine.spoken()).toBe(2);

    // ... and the streak still ends on schedule.
    h.advance(Buddy.NUDGE_GAP_MS * 3);
    expect(h.exhausted()).toBe(1);
  });

  it('starts a fresh count once the user actually speaks', () => {
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 3;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    h.advance(Buddy.NUDGE_GAP_MS);
    expect(h.machine.spoken()).toBe(2);

    h.machine.userSpoke();
    expect(h.machine.spoken()).toBe(0);
    expect(h.machine.isExhausted()).toBe(false);
    expect(h.machine.isActive()).toBe(false);

    // The next streak gets the full allowance again, from zero nags.
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    expect(h.speaks()).toBe(3);
    expect(h.exhausted()).toBe(0);
  });

  it('keeps the cap reachable for every stored settings shape', () => {
    // 到点关视频 is locked on, so the cap must exist no matter what an older
    // build (or a hand-edited storage object) says. If normalizeSettings ever
    // starts honouring an explicit `false` again, the cap silently disappears
    // and 「催满关页」 stops happening — the exact bug this lock was added for.
    for (const raw of [{}, { limitEnabled: false }, { limitEnabled: true }, { dwellSeconds: 10 }]) {
      const settings = Buddy.normalizeSettings(raw);
      expect(settings.limitEnabled, JSON.stringify(raw)).toBe(true);
      expect(settings.nudgeLimitCount, JSON.stringify(raw)).toBeGreaterThan(0);
    }
  });

  it('has no cap from a raw off object that bypassed normalization', () => {
    // The page can only hold normalized settings, but `cap` still has to be
    // conservative: closing tabs is the limiter's power, and a hand-written
    // `false` must never give the nudge that power. Driven through the real
    // machine so the getter — not a re-implementation — is what gets checked.
    const h = harness();
    h.cap.enabled = false;
    h.advance(Buddy.NUDGE_AFTER_MS + Buddy.NUDGE_GAP_MS * 40);
    expect(h.exhausted()).toBe(0);
    expect(h.speaks()).toBeGreaterThan(30);
    expect(h.machine.isActive()).toBe(true);
  });

  it('drops the cap mid-streak when the limiter switch is turned off', () => {
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 3;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    h.cap.enabled = false;
    h.advance(Buddy.NUDGE_GAP_MS * 5);
    expect(h.exhausted()).toBe(0);
  });

  it('shuts down by itself from inside the callback, without re-arming', () => {
    // This is exactly what the page does: `onExhausted` calls the limiter,
    // which calls `nudge.stop()` synchronously. The machine must not let the
    // remainder of that tick put it back into an active run.
    let clock = 1_000_000;
    let exhausted = 0;
    const machine: NudgeMachine = Buddy.createNudgeMachine({
      now: () => clock,
      cap: () => 3,
      onExhausted: () => {
        exhausted += 1;
        machine.stop();
      },
    });
    // Enough ticks to clear the 5-minute silence window and two 5-second gaps.
    for (let i = 0; i < 1200; i += 1) {
      clock += 400;
      machine.tick();
    }
    expect(exhausted).toBe(1);
    expect(machine.spoken()).toBe(3);
    expect(machine.isExhausted()).toBe(true);
  });

  it('gives the page back when the tab could not be closed', () => {
    // If neither chrome.tabs.remove nor window.close works, the freeze has to
    // be undone: otherwise the tracker stays paused for the rest of the tab's
    // life and the cat never speaks again. The silence window restarts so the
    // user is not nagged the instant the release happens.
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 3;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    h.advance(Buddy.NUDGE_GAP_MS * 2 + 1000);
    expect(h.machine.isActive()).toBe(true);
    expect(h.machine.isExhausted()).toBe(true);

    h.machine.release();
    expect(h.machine.isActive()).toBe(false);
    expect(h.machine.isExhausted()).toBe(false);
    expect(h.machine.spoken()).toBe(0);

    const before = h.speaks();
    h.advance(Buddy.NUDGE_AFTER_MS - 5000);
    expect(h.speaks()).toBe(before);
  });

  it('release() is a no-op unless the cap actually fired', () => {
    const h = harness();
    h.cap.enabled = true;
    h.cap.count = 10;
    h.advance(Buddy.NUDGE_AFTER_MS + 1);
    const lastBefore = h.machine.lastUserAt();
    h.machine.release();
    expect(h.machine.spoken()).toBe(1);
    expect(h.machine.lastUserAt()).toBe(lastBefore);
    expect(h.machine.isActive()).toBe(true);
  });

  it('keeps every shutdown line inside the persona', () => {
    const lines = Buddy.LIMIT_LINES.nag;
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line, line).toMatch(/喵[。！？!?]*$/);
      // Own setting, not the model's guess, so a number is allowed here — but
      // still no watch-time wording (CLAUDE.md §2.1.5).
      expect(line, line).not.toMatch(/\d+\s*(秒|分钟)|毫秒/);
      expect(line).toContain('{count}');
    }
    expect(Buddy.pickLimitLine('nag')).toContain('{count}');
  });
});

describe('limitAfterNag vs limitAfterShutdown', () => {
  it('keeps the time already spent today, so ignoring the cat is not a refund', () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const today = Buddy.dayKey(now);
    const saved = { day: today, usedMs: 12 * 60_000, shutAt: 0 };

    const shutdown = Buddy.limitAfterShutdown(now);
    expect(shutdown.usedMs).toBe(0);
    expect(shutdown.shutAt).toBe(now);

    const nag = Buddy.limitAfterNag(saved, now);
    expect(nag.usedMs).toBe(12 * 60_000);
    expect(nag.shutAt).toBe(now);
    expect(nag.day).toBe(today);
  });

  it('does not carry a previous day total into today', () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const nag = Buddy.limitAfterNag({ day: '2026-10-24', usedMs: 20 * 60_000, shutAt: 0 }, now);
    expect(nag.usedMs).toBe(0);
    expect(nag.day).toBe(Buddy.dayKey(now));
  });

  it('survives a corrupted ledger', () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    for (const raw of [null, undefined, 'nope', { usedMs: 'x', day: 7 }]) {
      const nag = Buddy.limitAfterNag(raw, now);
      expect(nag.usedMs).toBe(0);
      expect(nag.shutAt).toBe(now);
    }
  });
});

describe('nudgeStep', () => {
  it('collapses every off switch to inactive', () => {
    const now = 10 * MINUTE;
    const quiet = { lastUserAt: 0, active: false, nextAt: 0 };
    for (const flags of [
      { enabled: false, proactive: true, visible: true },
      { enabled: true, proactive: false, visible: true },
      { enabled: true, proactive: true, visible: false },
    ]) {
      expect(Buddy.nudgeStep(quiet, now, flags)).toEqual({
        active: false,
        nextAt: 0,
        speak: false,
        lastUserAt: 0,
      });
    }
  });

  it('is a function of its inputs, so a repeated tick cannot double-speak', () => {
    const now = 10 * MINUTE;
    const first = Buddy.nudgeStep({ lastUserAt: MINUTE, active: false, nextAt: 0 }, now, {
      enabled: true,
      proactive: true,
      visible: true,
    });
    expect(first.speak).toBe(true);
    // The caller feeds the result back in; the same timestamp must not speak
    // again, which is what keeps a slow or doubled tick harmless.
    const second = Buddy.nudgeStep(
      { lastUserAt: MINUTE, active: first.active, nextAt: first.nextAt },
      now,
      { enabled: true, proactive: true, visible: true },
    );
    expect(second).toEqual({
      active: true,
      nextAt: first.nextAt,
      speak: false,
      lastUserAt: MINUTE,
    });
  });
});

describe('content script wiring', () => {
  const content = readFileSync(
    fileURLToPath(new URL('../../extension/content/buddy.js', import.meta.url)),
    'utf8',
  );

  it('freezes dwell time and the daily budget while the nag runs', () => {
    // The brief is explicit: while the 5-second nag timer runs, the video dwell
    // counter must pause and resume afterwards. The budget has to pause with it
    // — a tab that is being nagged is not being watched, so charging the daily
    // quota for it would punish the user for not answering.
    //
    // Both counters therefore sit below one early return. Assert the return
    // itself and that its body precedes both `limiter.add` and `accumulated +=`,
    // rather than trusting that they happen to be stacked in that order.
    const tick = content.slice(content.indexOf('function tick('));
    const gate = tick.match(/if \(([^)]*nudge\.isActive\(\)[^)]*)\) \{/);
    expect(gate, 'the nag gate is gone').not.toBeNull();
    expect(gate?.[1]).toContain('!playing');
    expect(gate?.[1]).toContain('delta <= 0');

    const gateIndex = tick.indexOf(gate![0]);
    expect(tick.indexOf('limiter.add')).toBeGreaterThan(gateIndex);
    expect(tick.indexOf('accumulated +=')).toBeGreaterThan(gateIndex);
  });

  it('runs the nag before the video checks, so it does not depend on a video', () => {
    const tick = content.slice(content.indexOf('function tick('));
    const body = tick.slice(0, tick.indexOf('pickVideo'));
    expect(body).toContain('nudge.tick()');
  });

  it('only resets the silence clock where the user actually typed', () => {
    // openers, video reactions and the nag itself must never touch it, or the
    // cat resets its own timer and never gets to nag.
    expect(content.match(/userSpoke|nudge\.resolve\(\)/g)?.length).toBeGreaterThan(0);
    const sendMessage = content.slice(content.indexOf('function sendMessage()'));
    const head = sendMessage.slice(0, sendMessage.indexOf('startStream'));
    expect(head).toContain('nudge.resolve()');
  });

  it('announces the budget once per conversation and stays silent when off', () => {
    const announce = content.slice(content.indexOf('function announceBudget'));
    const body = announce.slice(0, announce.indexOf('function backoff'));
    expect(body).toContain('state.budgetAnnounced');
    expect(body).toContain('Buddy.limitBudgetMs(settings)');
    // The number is the user's own setting, so it is said without the network
    // even when 主动搭话 is off — but never when there is no budget at all.
    expect(body).not.toContain('settings.proactive');
    expect(content).toMatch(/state\.budgetAnnounced\s*=\s*false[\s\S]{0,80}nudge\.restart\(\)/);
  });

  it('reaches the budget notice from the first message and from the load path', () => {
    // Either may come first — a user who types immediately, or one who only
    // watches — and whichever does announces. Both paths must stay wired: lose
    // the scheduled one and a silent viewer hears the number only at closing
    // time; lose the message path and their first line arrives before the
    // heads-up.
    const sendMessage = content.slice(content.indexOf('function sendMessage()'));
    const head = sendMessage.slice(0, sendMessage.indexOf('startStream'));
    expect(head).toContain('announceBudget()');

    // The notice is stepped from the tracker tick, not from a `setTimeout`.
    // Its own timer was the first implementation and dropped the line about one
    // run in four (throttled background timers and a cancel/re-arm race); the
    // tick is already the heartbeat and cannot be lost that way.
    const tickBudget = content.slice(content.indexOf('function tickBudget'));
    expect(tickBudget.slice(0, tickBudget.indexOf('function backoff'))).toContain('announceBudget()');
    expect(content).not.toMatch(/setTimeout\(function \(\) \{[^}]*announceBudget\(\)/);

    // The tracker tick, from its definition down to the next module. Slicing on
    // `var tracker` would come out empty: the tick is defined *inside* it.
    const trackerTick = content.slice(content.indexOf('function tick()'), content.indexOf('var limiter = (function'));
    expect(trackerTick).toContain('tickBudget()');
    // The limiter's "allowed to watch" callback is where the deadline is armed,
    // so a page that is about to be closed never announces a budget.
    expect(content).toMatch(/limiter\.start\(function \(\) \{[\s\S]{0,120}scheduleBudget\(\)/);
  });

  it('keeps the budget notice out of the dwell reaction', () => {
    // It used to be announced from onDwell(), which fired it in the same tick
    // as the first reaction: its bubble was replaced before it could be read,
    // and the "before anything happens" warning landed after something had
    // already happened. Scheduling it from the page load is what separates the
    // two, so a call creeping back here would silently undo the fix.
    const onDwell = content.slice(content.indexOf('async function onDwell'));
    // Just the head of the function: everything before the state change that
    // starts the request. A call anywhere in there is the regression.
    const head = onDwell.slice(0, onDwell.indexOf("ui.setState('thinking')"));
    expect(head).not.toContain('announceBudget()');
    // The lead has to stay shorter than the shortest dwell, otherwise a fast
    // setting would still put a reaction first.
    expect(Buddy.BUDGET_LEAD_MS).toBeGreaterThan(0);
    expect(Buddy.BUDGET_LEAD_MS).toBeLessThan(Buddy.DWELL_MIN * 1000);
  });

  it('cancels a pending budget notice when there is no one to read it', () => {
    // A bubble must not appear after the plugin was switched off, nor surface
    // minutes later when the user comes back to a conversation that moved on.
    const applySettings = content.slice(content.indexOf('function applySettings'));
    expect(applySettings.slice(0, applySettings.indexOf('applyPosition'))).toContain('cancelBudgetTimer()');
    const hidden = content.slice(content.indexOf("if (document.visibilityState === 'hidden')"));
    expect(hidden.slice(0, hidden.indexOf("document.visibilityState !== 'visible'"))).toContain('cancelBudgetTimer()');
    // ...and it is re-armed on the way back, or hiding once would cost the user
    // the reminder for the rest of the conversation. Anchored past the hidden
    // branch's own cancel, because the tracker checks visibility too and an
    // earlier match would slice the wrong block.
    const returnAfterHidden = hidden.indexOf('cancelBudgetTimer();');
    expect(hidden.slice(returnAfterHidden)).toContain('scheduleBudget()');
  });

  it('drops the nag when the tab is hidden or the page is closing', () => {
    const sayAndClose = content.slice(content.indexOf('function sayAndClose'));
    expect(sayAndClose.slice(0, sayAndClose.indexOf('pickLimitLine'))).toContain('nudge.stop()');
    const hidden = content.slice(content.indexOf("if (document.visibilityState === 'hidden')"));
    expect(hidden.slice(0, hidden.indexOf('nudge.stop') + 20)).toContain('nudge.stop()');
  });
});
