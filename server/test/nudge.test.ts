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
  tick(): void;
  userSpoke(): void;
  restart(): void;
  stop(): void;
}

interface MachineOptions {
  now(): number;
  enabled?(): boolean;
  proactive?(): boolean;
  visible?(): boolean;
  onSpeak?(): void;
  onStop?(): void;
  lastUserAt?: number;
}

interface NudgeApi {
  DEFAULTS: { limitMinutes: number };
  NUDGE_AFTER_MS: number;
  NUDGE_GAP_MS: number;
  NUDGE_LINES: string[];
  BUDGET_LINES: string[];
  pickNudgeLine(recent?: unknown): string;
  pickBudgetLine(minutes: unknown, recent?: unknown): string;
  nudgeDue(lastUserAt: unknown, nowMs: unknown): boolean;
  nudgeStep(
    current: NudgeState,
    nowMs: number,
    flags: NudgeFlags,
  ): { active: boolean; nextAt: number; speak: boolean };
  createNudgeMachine(options: MachineOptions): NudgeMachine;
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
  const flags = { enabled: true, proactive: true, visible: true };

  const machine = Buddy.createNudgeMachine({
    now: () => clock,
    enabled: () => flags.enabled,
    proactive: () => flags.proactive,
    visible: () => flags.visible,
    onSpeak: () => { speaks += 1; },
    onStop: () => { stops += 1; },
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
    advance,
    speaks: () => speaks,
    stops: () => stops,
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

  it('reaches the budget notice from both the first message and the first reaction', () => {
    // "在第一次对话与停留某一视频10秒产生的对话之间" means either one may come
    // first, and whichever does announces. Missing either call site would leave
    // a user who never types hearing about the budget only at closing time.
    const calls = content.match(/^\s*announceBudget\(\);$/gm) ?? [];
    expect(calls.length).toBe(2);

    const onDwell = content.slice(content.indexOf('function onDwell'));
    const beforeRequest = onDwell.slice(0, onDwell.indexOf('ui.setState'));
    expect(beforeRequest).toContain('announceBudget()');

    const sendMessage = content.slice(content.indexOf('function sendMessage()'));
    const head = sendMessage.slice(0, sendMessage.indexOf('startStream'));
    expect(head).toContain('announceBudget()');
  });

  it('announces before the first reaction rather than after the model replies', () => {
    // The notice is the user's own setting read back, so it must not wait on a
    // request that might fail or be slow.
    const onDwell = content.slice(content.indexOf('function onDwell'));
    expect(onDwell.indexOf('announceBudget()')).toBeLessThan(onDwell.indexOf('readScreenText'));
    expect(onDwell.indexOf('announceBudget()')).toBeLessThan(onDwell.indexOf('sm:analyze'));
  });

  it('drops the nag when the tab is hidden or the page is closing', () => {
    const sayAndClose = content.slice(content.indexOf('function sayAndClose'));
    expect(sayAndClose.slice(0, sayAndClose.indexOf('pickLimitLine'))).toContain('nudge.stop()');
    const hidden = content.slice(content.indexOf("if (document.visibilityState === 'hidden')"));
    expect(hidden.slice(0, hidden.indexOf('nudge.stop') + 20)).toContain('nudge.stop()');
  });
});
