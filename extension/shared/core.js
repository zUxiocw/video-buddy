/*
 * Shared, dependency-free helpers for the content script, service worker,
 * popup and Node tests. Loaded as a classic script, so it attaches `Buddy`
 * to the global object instead of using ES modules.
 */
(function (root) {
  'use strict';

  var TONE = 'maomao';
  // 悬浮球直径：一个抖音头像约 48px，区间取 1–2 个头像大小。
  var BALL_SIZE_MIN = 40;
  var BALL_SIZE_MAX = 96;

  /*
   * Numeric ranges. The ones that gate network requests are anchored to the
   * server's own budget (RATE_ANALYZE_PER_MINUTE 6, PER_HOUR 60), because a
   * setting below that floor turns a normal scroll session into 429s — which
   * the user sees as the cat going quiet mid-conversation.
   *
   * These constants are exported so the tests can assert popup.html's min/max
   * still match. That pair drifting apart is silent (a range the UI offers but
   * the client silently clamps) and has happened before.
   */
  // 10s is derived, not guessed. The server allows 6 analyze/min, and that is
  // a hard ceiling rather than a target: a reaction can never come sooner than
  // `dwellSeconds` (the tick only fires once `accumulated >= goal`), so a
  // rolling 60s window can hold at most 6 of them. No margin is needed because
  // the spacing is enforced by construction, not by luck.
  //
  // At the old 3s floor a fast scroll asked ~20 times a minute, so most
  // reactions came back 429 — which the user saw as the cat going quiet
  // mid-conversation. The default moves with the floor (8 -> 10) so DEFAULTS
  // and the clamp cannot disagree; a default below its own floor is silently
  // changed by normalizeSettings, which is how these drifted apart last time.
  var DWELL_MIN = 10;
  var DWELL_MAX = 120;
  // A repeat every 5s on one long video is 12 requests a minute by itself. 20s
  // is the shortest interval that stays under the minute budget while still
  // feeling like it is reacting to the video.
  var REPEAT_DWELL_MIN = 20;
  var REPEAT_DWELL_MAX = 600;
  // Only used after a failed call, so 0 is not "no delay" — it is "retry into
  // the 429 that just fired". 10s is the floor; 300s is past every server
  // window, so a longer value is just a broken setting.
  var COOLDOWN_MIN = 10;
  var COOLDOWN_MAX = 300;
  // Cosmetic, but a bubble shorter than it takes to read a sentence is noise.
  var BUBBLE_MIN = 6;
  var BUBBLE_MAX = 120;
  // 0 means "hold until the next change"; beyond a minute it reads as stuck.
  var EMOTION_HOLD_MIN = 0;
  var EMOTION_HOLD_MAX = 60;
  // Local only (no requests): the tab simply closes. 30s is long enough to
  // read the line it just said.
  var LIMIT_CLOSE_MIN = 0;
  var LIMIT_CLOSE_MAX = 30;
  // Left alone on purpose: this knob makes no network requests, so it cannot
  // contribute to the request storms the other floors exist to prevent. The
  // 1-minute setting also has to stay legal — it is how the limiter is
  // regression-tested end to end without waiting half an hour.
  var LIMIT_MINUTES_MIN = 1;
  var LIMIT_MINUTES_MAX = 600;
  var LIMIT_COOLDOWN_MIN = 0;
  var LIMIT_COOLDOWN_MAX = 720;
  // Silence nudge. Both numbers are deliberately NOT settings and have no
  // MIN/MAX pair: the site tells users 「5 分钟与 5 秒间隔固定，不提供修改」,
  // and a configurable version would need its own validation, migration and
  // popup row for no benefit. Exported so the tests and the page agree.
  var NUDGE_AFTER_MS = 5 * 60 * 1000;
  var NUDGE_GAP_MS = 5 * 1000;
  // Bump when the stored settings shape changes in a way that needs a one-off
  // migration. normalizeSettings passes an older stamp through unchanged, so
  // future code can branch on it; a stored object with no stamp is version 1.
  var SETTINGS_VERSION = 2;
  var DEFAULTS = {
    enabled: true,
    // Whether the cat speaks up on its own after a dwell. On for both fresh
    // installs and existing ones: this switch exists so the site's promise
    // 「主动搭话可以单独关闭」 is true, not to change anyone's current
    // behaviour. Off means the ball and the chat panel still work.
    proactive: true,
    // Whether the screenshot rides along with the analyze request. On by
    // default, as before; off sends caption + hashtags only.
    captureEnabled: true,
    // Which path requests take. 'server' = the local Fastify service (the
    // original, still-supported mode); 'direct' = the service worker calls
    // DeepSeek with the user's own key. Kept as a string rather than a boolean
    // so a third mode can be added without another shape change.
    //
    // Fresh installs default to 'direct' because that is what the public build
    // is: the download page hands the user a BYOK setup, and a stranger has no
    // local service to point at. Instalments that predate the field keep
    // 'server' — see legacyMode() below.
    mode: 'direct',
    serverUrl: 'http://127.0.0.1:8787',
    appToken: '',
    // Only used in 'direct' mode. Stored in chrome.storage.local, which content
    // scripts can read but page scripts cannot (content scripts run in an
    // isolated world). The popup says so in plain words next to the field.
    apiKey: '',
    apiBaseUrl: 'https://api.deepseek.com',
    deviceId: '',
    // Must be >= DWELL_MIN below, otherwise normalizeSettings clamps the
    // default and the two silently disagree.
    dwellSeconds: 10,
    // A long video keeps playing after the first reaction; this is how long to
    // wait before speaking again. 0 = one reaction per viewing, as before.
    repeatDwellSeconds: 60,
    cooldownSeconds: 45,
    autoOpenPanel: false,
    bubbleSeconds: 20,
    emotionHoldSeconds: 6,
    ballSize: 60,
    // Watch-time budget. Time only accrues while a video plays on a visible
    // page; when the budget runs out the cat says so, then the tab is closed.
    // On for a fresh install: watching time is the product's core boundary,
    // and the site promises this default. An explicit `false` still wins, so
    // anyone who turns it off keeps it off.
    limitEnabled: true,
    limitMinutes: 30,
    // After a shutdown, every fresh page gets one warning and is closed again
    // for this long. 0 = close once and stop interfering.
    limitCooldownMinutes: 10,
    // How long the line stays readable before the tab goes away.
    limitCloseSeconds: 5,
  };
  var DEVICE_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
  // Kept in sync with shared/emotions.js ORDER; listed here because core.js is
  // loaded first and must not depend on the emotions module.
  var EMOTION_IDS = ['sad', 'happy', 'annoyed', 'angry', 'laugh', 'excited', 'greet', 'confused', 'shocked'];
  var HISTORY_KEY = 'smHistory';
  var MAX_HISTORY_SESSIONS = 20;
  var MAX_SESSION_MESSAGES = 300;
  var MAX_MESSAGE_CHARS = 2000;
  // Mirrors the ceiling in server/src/routes/analyze.ts. The client clamps to it
  // too, because the accumulated on-screen time on a repeating long video can
  // exceed it and a raw value would be rejected as invalid input.
  var MAX_DWELL_MS = 900_000;

  function hasCrypto() {
    return !!root.crypto && typeof root.crypto.getRandomValues === 'function';
  }

  function randomHex(bytes) {
    var out = '';
    var data = new Uint8Array(bytes);
    if (hasCrypto()) {
      root.crypto.getRandomValues(data);
    } else {
      for (var i = 0; i < data.length; i += 1) data[i] = Math.floor(Math.random() * 256);
    }
    for (var j = 0; j < data.length; j += 1) out += data[j].toString(16).padStart(2, '0');
    return out;
  }

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    var hex = randomHex(16);
    return (
      hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20)
    );
  }

  function makeDeviceId() {
    return 'sm-' + randomHex(12);
  }

  function clampInt(value, fallback, min, max) {
    var parsed = typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  /**
   * The repeat interval is the one range with a meaningful zero: 0 turns
   * repeats off, every other value is a positive delay. Clamping it with
   * `max(min, value)` would turn "off" into "the minimum", which is the exact
   * opposite of what the user asked for — so 0 is special-cased first.
   */
  function normalizeRepeatDwell(value) {
    var parsed = typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
    if (!Number.isFinite(parsed)) return DEFAULTS.repeatDwellSeconds;
    if (parsed <= 0) return 0;
    return Math.min(REPEAT_DWELL_MAX, Math.max(REPEAT_DWELL_MIN, Math.round(parsed)));
  }

  function normalizeServerUrl(value) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (!/^https?:\/\//i.test(text)) return DEFAULTS.serverUrl;
    text = text.replace(/\/+$/, '');
    try {
      var url = new URL(text);
      if (!url.hostname) return DEFAULTS.serverUrl;
      return url.origin + url.pathname.replace(/\/+$/, '');
    } catch (_error) {
      return DEFAULTS.serverUrl;
    }
  }

  /**
   * Base URL for the OpenAI-compatible provider used in direct mode.
   *
   * Stricter than normalizeServerUrl on purpose: this one is combined with the
   * user's API key, so a typo that silently fell back to a default would send
   * a real bearer token to a host the user did not intend. Plain http is
   * therefore rejected — the one exception is loopback, which never leaves the
   * machine. That exception is what makes the mode testable against a local
   * stub instead of spending real tokens on every run, and both loopback hosts
   * are already in host_permissions for server mode, so it grants nothing new.
   */
  function normalizeApiBaseUrl(value) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (!text) return DEFAULTS.apiBaseUrl;
    var secure = /^https:\/\//i.test(text);
    var loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(text);
    if (!secure && !loopback) return DEFAULTS.apiBaseUrl;
    try {
      var url = new URL(text);
      if (!url.hostname) return DEFAULTS.apiBaseUrl;
      return url.origin + url.pathname.replace(/\/+$/, '');
    } catch (_error) {
      return DEFAULTS.apiBaseUrl;
    }
  }

  /**
   * Settings saved by a build that predates `limitEnabled` carry no value for
   * it, so they would fall through to the (now off) default and silently lose
   * a feature the user was already relying on. A saved object that has other
   * keys but no `limitEnabled` is such an instalment: keep it on. An empty
   * object is a fresh install and gets the new default.
   */
  function legacyLimitEnabled(source) {
    if (Object.prototype.hasOwnProperty.call(source, 'limitEnabled')) return undefined;
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) return true;
    }
    return undefined;
  }

  /**
   * Same problem as legacyLimitEnabled, one field over: `mode` now defaults to
   * 'direct' for fresh installs, but every machine that saved settings before
   * this field existed is talking to a local service that does work. Letting
   * those fall through to the new default would reroute their requests to a
   * provider they never configured a key for — the cat goes silent on upgrade.
   *
   * A saved object with other keys but no `mode` is such an instalment: keep it
   * on 'server'. An explicit value always wins.
   */
  function legacyMode(source) {
    if (Object.prototype.hasOwnProperty.call(source, 'mode')) return undefined;
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) return 'server';
    }
    return undefined;
  }

  /**
   * Whether this route has enough credentials to actually make a call.
   *
   * The content script used to gate proactive talk on `settings.appToken`
   * alone. That was correct when 'server' was the only path, but `appToken` is
   * hidden and unused in 'direct' mode: a fresh BYOK install has an empty
   * string forever, so onDwell() returned before it ever sent a request and
   * the cat never spoke on its own. Existing machines only appeared to work
   * because they still carried an `appToken` from an earlier server setup.
   *
   * One predicate, so a third mode cannot silently re-create the same hole.
   */
  function modeConfigured(settings) {
    if (!settings) return false;
    if (settings.mode === 'direct') return !!settings.apiKey;
    return !!settings.appToken;
  }

  function normalizeSettings(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var deviceId = typeof source.deviceId === 'string' ? source.deviceId.trim() : '';
    if (!DEVICE_ID_RE.test(deviceId)) deviceId = makeDeviceId();
    var legacyLimit = legacyLimitEnabled(source);
    var legacyRoute = legacyMode(source);
    return {
      enabled: source.enabled === undefined ? DEFAULTS.enabled : !!source.enabled,
      // Both default to true for a missing key, so an upgrade keeps exactly the
      // behaviour it had before these switches existed.
      proactive: source.proactive === undefined ? DEFAULTS.proactive : !!source.proactive,
      captureEnabled: source.captureEnabled === undefined ? DEFAULTS.captureEnabled : !!source.captureEnabled,
      // 'server' keeps talking to the local Fastify service; 'direct' calls the
      // model from the service worker with the user's own key. Only the exact
      // string 'direct' selects the new path: an unrecognised value must not
      // silently reroute a working instalment. Missing entirely means the
      // settings predate the field, which legacyMode() resolves to 'server'.
      mode: source.mode === 'direct'
        ? 'direct'
        : (source.mode === 'server' ? 'server' : (legacyRoute !== undefined ? legacyRoute : DEFAULTS.mode)),
      serverUrl: normalizeServerUrl(source.serverUrl),
      appToken: typeof source.appToken === 'string' ? source.appToken.trim() : '',
      // Trimmed here so a pasted key with a trailing newline does not fail with
      // a 401 that looks like a wrong key.
      apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
      apiBaseUrl: normalizeApiBaseUrl(source.apiBaseUrl),
      deviceId: deviceId,
      dwellSeconds: clampInt(source.dwellSeconds, DEFAULTS.dwellSeconds, DWELL_MIN, DWELL_MAX),
      repeatDwellSeconds: normalizeRepeatDwell(source.repeatDwellSeconds),
      cooldownSeconds: clampInt(source.cooldownSeconds, DEFAULTS.cooldownSeconds, COOLDOWN_MIN, COOLDOWN_MAX),
      autoOpenPanel: !!source.autoOpenPanel,
      bubbleSeconds: clampInt(source.bubbleSeconds, DEFAULTS.bubbleSeconds, BUBBLE_MIN, BUBBLE_MAX),
      emotionHoldSeconds: clampInt(
        source.emotionHoldSeconds,
        DEFAULTS.emotionHoldSeconds,
        EMOTION_HOLD_MIN,
        EMOTION_HOLD_MAX,
      ),
      ballSize: clampInt(source.ballSize, DEFAULTS.ballSize, BALL_SIZE_MIN, BALL_SIZE_MAX),
      limitEnabled: source.limitEnabled !== undefined
        ? !!source.limitEnabled
        : (legacyLimit !== undefined ? legacyLimit : DEFAULTS.limitEnabled),
      limitMinutes: clampInt(source.limitMinutes, DEFAULTS.limitMinutes, LIMIT_MINUTES_MIN, LIMIT_MINUTES_MAX),
      limitCooldownMinutes: clampInt(
        source.limitCooldownMinutes,
        DEFAULTS.limitCooldownMinutes,
        LIMIT_COOLDOWN_MIN,
        LIMIT_COOLDOWN_MAX,
      ),
      limitCloseSeconds: clampInt(
        source.limitCloseSeconds,
        DEFAULTS.limitCloseSeconds,
        LIMIT_CLOSE_MIN,
        LIMIT_CLOSE_MAX,
      ),
      // Stamped so a future release can migrate a stored shape instead of
      // guessing from which keys happen to be present. Absent on anything
      // written before this field existed; treat that as version 1. A stamp
      // from a newer build is preserved, not clamped away: a downgrade must
      // not destroy the information that the data is ahead of this code.
      settingsVersion: Math.max(
        1,
        Math.round(Number(source.settingsVersion)) || SETTINGS_VERSION,
      ),
    };
  }

  /**
   * How long the ball keeps a mood icon. `overrideMs` comes from a specific
   * event (0 = keep until the next change); otherwise the popup setting wins.
   */
  function emotionHoldMs(settings, overrideMs) {
    if (overrideMs === 0) return 0;
    var hold = overrideMs > 0 ? overrideMs : Number(settings && settings.emotionHoldSeconds) * 1000;
    return Number.isFinite(hold) && hold > 0 ? Math.round(hold) : 0;
  }

  /** How long a chat bubble stays on screen, from the popup setting. */
  function bubbleMs(settings) {
    var seconds = Number(settings && settings.bubbleSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULTS.bubbleSeconds * 1000;
  }

  /**
   * How long to keep watching the *same* video before speaking again.
   *
   * The first reaction uses `dwellSeconds`. After that a long video gets one
   * line per `repeatDwellSeconds`, so an eight-minute clip is not silent for
   * seven of those minutes. 0 disables repeats (one reaction per viewing).
   */
  function repeatDwellMs(settings) {
    var raw = settings && settings.repeatDwellSeconds;
    // A missing setting means "not configured yet", so fall back to the
    // default — unlike an explicit 0, which means the user turned repeats off.
    var seconds = raw === undefined || raw === null || raw === ''
      ? DEFAULTS.repeatDwellSeconds
      : Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000);
  }

  /**
   * Where in the dwell window to grab a frame, as fractions of the wait.
   *
   * Sampling over time (rather than seeking) is deliberate: seeking would
   * interrupt playback, and a static end frame says nothing about how the
   * video moves. `count` is clamped to 1–6; the last point is always 1 so the
   * very last moment of the window is included.
   */
  function frameSamplePoints(count) {
    var total = clampInt(count, 4, 1, 6);
    // A single frame is the end of the window, by definition.
    if (total === 1) return [1];
    var points = [];
    for (var i = 1; i <= total; i += 1) {
      // 0.3, 0.55, 0.8, 1 for four frames: front-loaded, because the opening
      // of a short clip carries more of the setup than the tail does.
      var fraction = 0.3 + (0.7 * (i - 1)) / (total - 1);
      points.push(Math.min(1, Math.round(fraction * 100) / 100));
    }
    return points;
  }

  /**
   * Coarse length bucket for the video itself.
   *
   * Only the bucket leaves the page, never the number: the model gets to know
   * whether there is room for a build-up, but has nothing it can quote back as
   * 「这个十五秒的视频」 — the same leak that made every reaction say 「八秒」.
   */
  function videoBucket(seconds) {
    var value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 30) return 'short';
    if (value < 180) return 'medium';
    return 'long';
  }

  /**
   * How long the current viewing of a video must accumulate before the next
   * line. `firedCount` is how many times this viewing has already spoken.
   * Returns 0 when there is nothing left to wait for (repeats switched off).
   */
  function dwellGoalMs(settings, firedCount) {
    if (!(firedCount > 0)) {
      var first = Number(settings && settings.dwellSeconds);
      return Number.isFinite(first) && first > 0 ? Math.round(first * 1000) : DEFAULTS.dwellSeconds * 1000;
    }
    return repeatDwellMs(settings);
  }

  /* ---------------------------------------------------------------- */
  /* watch-time budget                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Daily-ish watch budget. Deliberately wall-clock-free: the content script
   * adds only the milliseconds the video was actually playing on a visible
   * page, so a paused tab or a background tab costs nothing.
   *
   * Two things are persisted (see LIMIT_KEY): how much of the budget is used,
   * and when the tab was last shut down. The shutdown timestamp is what makes
   * an early return detectable after the page is gone.
   */
  var LIMIT_KEY = 'smLimit';

  /** Budget in ms; 0 means the limiter is switched off. */
  function limitBudgetMs(settings) {
    if (settings && settings.limitEnabled === false) return 0;
    var minutes = Number(settings && settings.limitMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      minutes = DEFAULTS.limitMinutes;
    }
    return Math.round(minutes * 60 * 1000);
  }

  /** How long after a shutdown a reopened page is turned away again. */
  function limitCooldownMs(settings) {
    var minutes = Number(settings && settings.limitCooldownMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) minutes = DEFAULTS.limitCooldownMinutes;
    return Math.round(minutes * 60 * 1000);
  }

  /** How long the line stays readable before the tab is closed. */
  function limitCloseDelayMs(settings) {
    var seconds = Number(settings && settings.limitCloseSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) seconds = DEFAULTS.limitCloseSeconds;
    return Math.round(seconds * 1000);
  }

  /** Local calendar day, used to give the budget a fresh start each morning. */
  function dayKey(nowMs) {
    var now = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();
    var pad = function (value) { return String(value).padStart(2, '0'); };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  /**
   * Coerce the persisted limiter state. Anything unreadable becomes a clean
   * slate rather than a crash: a corrupted key must not cost the user the
   * whole feature (or, worse, close tabs at random).
   */
  function normalizeLimitState(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var used = Number(source.usedMs);
    var shut = Number(source.shutAt);
    return {
      // A lifetime cumulative counter would eventually close every tab on
      // load, so the total is scoped to one calendar day.
      day: typeof source.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.day) ? source.day : '',
      usedMs: Number.isFinite(used) && used > 0 ? Math.min(used, 24 * 60 * 60 * 1000) : 0,
      // Kept raw on purpose: clamping it against the real clock here would
      // make this function depend on wall time, and the future-timestamp case
      // is a decision for limitSnapshot (which has the `now` to compare with).
      shutAt: Number.isFinite(shut) && shut > 0 ? shut : 0,
    };
  }

  /**
   * Everything the page needs to decide what to do on load.
   *
   * `inCooldown` wins over the used time: right after a shutdown the clock is
   * deliberately frozen, so returning early does not "use up" the next budget.
   * Once the cooldown lapses the budget restarts at zero — the user gets a
   * whole new window instead of being closed again a minute later.
   */
  function limitSnapshot(saved, nowMs, settings) {
    var state = normalizeLimitState(saved);
    var budgetMs = limitBudgetMs(settings);
    var cooldownMs = limitCooldownMs(settings);
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    // Yesterday's total is not today's problem.
    if (state.day && state.day !== dayKey(now)) state.usedMs = 0;
    if (budgetMs <= 0) {
      return { disabled: true, budgetMs: 0, usedMs: 0, inCooldown: false, cooldownLeftMs: 0, overBudget: false };
    }
    // A timestamp in the future means the clock moved backwards (timezone
    // travel, manual change, a machine waking from sleep). Trusting it would
    // pin the page in cooldown for as long as the skew lasts, so it is
    // discarded and the budget is treated as normally spent.
    if (state.shutAt > now + 60 * 1000) state.shutAt = 0;
    if (state.shutAt > 0) {
      var elapsed = now - state.shutAt;
      if (elapsed < cooldownMs) {
        return {
          disabled: false,
          budgetMs: budgetMs,
          usedMs: 0,
          inCooldown: true,
          cooldownLeftMs: Math.max(0, cooldownMs - elapsed),
          overBudget: false,
        };
      }
      // The cooldown has passed: the previous budget is spent and gone.
      return { disabled: false, budgetMs: budgetMs, usedMs: 0, inCooldown: false, cooldownLeftMs: 0, overBudget: false };
    }
    return {
      disabled: false,
      budgetMs: budgetMs,
      usedMs: Math.min(state.usedMs, budgetMs),
      inCooldown: false,
      cooldownLeftMs: 0,
      overBudget: state.usedMs >= budgetMs,
    };
  }

  /** The state to persist the moment a tab is shut down for running out. */
  function limitAfterShutdown(nowMs) {
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    return { day: dayKey(now), usedMs: 0, shutAt: now };
  }

  /**
   * Charge playback time to the shared budget.
   *
   * Only the service worker calls this, because it is the single writer. If
   * each tab credited chrome.storage itself, two tabs would read the same base
   * and the later write would erase the earlier delta — chrome.storage has no
   * read-modify-write transaction. One owner also makes the total mean what it
   * says: the budget belongs to the browser, not to whichever tab asked.
   *
   * Returns the state to persist plus what the calling tab should do.
   */
  function limitCredit(saved, deltaMs, nowMs, settings) {
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    var state = normalizeLimitState(saved);
    var snap = limitSnapshot(state, now, settings);
    if (snap.disabled) {
      return { state: state, over: false, inCooldown: false, usedMs: 0, disabled: true };
    }
    if (snap.inCooldown) {
      // Nothing is charged while the door is shut: the page is about to be
      // closed, and billing it would eat into the next window.
      return { state: state, over: false, inCooldown: true, usedMs: 0, disabled: false };
    }
    var delta = Number(deltaMs);
    var credit = Number.isFinite(delta) && delta > 0 ? Math.round(delta) : 0;
    var used = Math.min(snap.budgetMs, snap.usedMs + credit);
    if (used >= snap.budgetMs) {
      // Stamp the cooldown here rather than letting the page do it: the page
      // dies with its tab, and several tabs can be spending at the same time.
      return { state: limitAfterShutdown(now), over: true, inCooldown: false, usedMs: used, disabled: false };
    }
    return {
      state: { day: dayKey(now), usedMs: used, shutAt: 0 },
      over: false,
      inCooldown: false,
      usedMs: used,
      disabled: false,
    };
  }

  /**
   * Lines for the two moments. Local templates on purpose: the tab has to be
   * closed even when the local service is down, so this cannot depend on
   * /v1/chat. Every line ends in 喵 like every other line the cat says.
   */
  var LIMIT_LINES = {
    // Budget ran out mid-scroll.
    over: [
      '差不多了哦，本喵要下班了喵',
      '到点了，眼睛该歇了，本喵先撤喵',
      '时间到，屏幕还亮着，人已经废了喵',
      '行了行了，今天到这儿，再刷我咬人喵',
      '该收工了，视频不会跑，你的眼睛会喵',
      '本喵下班，你也下班，都别刷了喵',
    ],
    // Page reopened while still in the cooldown.
    back: [
      '还敢点开，不给你刷了喵',
      '又来了？这才几分钟喵',
      '我说了下班，你还开，真不听话喵',
      '手这么快，是没听见我刚说什么喵',
      '回来得这么快，看来得再关一次喵',
      '不给你刷了，真的喵',
    ],
  };

  /** Pick a line of `kind` ('over' | 'back') avoiding the recent ones. */
  function pickLimitLine(kind, recent) {
    var pool = LIMIT_LINES[kind] || LIMIT_LINES.over;
    var seen = Array.isArray(recent) ? recent : [];
    var fresh = pool.filter(function (line) {
      return seen.indexOf(line) === -1;
    });
    var usable = fresh.length > 0 ? fresh : pool;
    var index = Math.floor(Math.random() * usable.length) % usable.length;
    return usable[index];
  }

  /* ---------------------------------------------------------------- */
  /* budget announcement + silence nudge (local lines)                 */
  /* ---------------------------------------------------------------- */

  /**
   * The first thing the cat says about the budget, before any time is spent.
   *
   * Announced once per conversation rather than at the deadline: the site's
   * promise is 「第一次对话就报总时长」, and a warning that only arrives when
   * the tab is about to close is not a heads-up, it is an ambush.
   *
   * These are local templates for the same reason the shutdown lines are: the
   * budget is enforced without the network, so explaining it must not depend
   * on /v1/chat either. `{minutes}` is substituted at the call site so the
   * number always matches the setting in force.
   *
   * Note the wording: this is the one place a duration is allowed, and only
   * because it is the user's own setting being read back, never the watch time
   * the model is forbidden to mention (see CLAUDE.md §2.1.5 — that rule is
   * about what reaches the prompt, not about what the extension says).
   */
  var BUDGET_LINES = [
    '先说好，今天给自己设了 {minutes} 分钟，到点我关页喵',
    '今天的额度是 {minutes} 分钟，本喵到点就动手喵',
    '{minutes} 分钟，说好了，到点不许赖喵',
    '提醒一下，今天设的是 {minutes} 分钟喵',
    '{minutes} 分钟一到，我就把你从这儿带走喵',
  ];

  function pickBudgetLine(minutes, recent) {
    var total = Number(minutes);
    var value = Number.isFinite(total) && total > 0 ? Math.round(total) : DEFAULTS.limitMinutes;
    var seen = Array.isArray(recent) ? recent : [];
    var fresh = BUDGET_LINES.filter(function (line) { return seen.indexOf(line) === -1; });
    var pool = fresh.length > 0 ? fresh : BUDGET_LINES;
    var index = Math.floor(Math.random() * pool.length) % pool.length;
    return pool[index].replace('{minutes}', String(value));
  }

  /**
   * Lines for the repeated nudge once the user has gone quiet.
   *
   * Deliberately nagging in tone — that is the brief — but every line still
   * ends in 喵 and none of them mentions a duration, so they stay inside the
   * persona. Shorter than the opener pool on purpose: repetition is the
   * mechanism here, and pretending otherwise would make the array longer
   * without making the behaviour less repetitive.
   */
  var NUDGE_LINES = [
    '喂，五分钟没理我了喵',
    '视频比我好看是吧喵',
    '你再不回，我就一直说喵',
    '看我一眼，就一眼喵',
    '行，你刷，我就在这儿念喵',
    '人呢，屏幕还亮着喵',
    '理我一下会少块肉吗喵',
    '我数到三，你再不说话我就继续数喵',
  ];

  function pickNudgeLine(recent) {
    var seen = Array.isArray(recent) ? recent : [];
    var fresh = NUDGE_LINES.filter(function (line) { return seen.indexOf(line) === -1; });
    var pool = fresh.length > 0 ? fresh : NUDGE_LINES;
    var index = Math.floor(Math.random() * pool.length) % pool.length;
    return pool[index];
  }

  /**
   * Whether the user has been quiet long enough for the nudge to start.
   *
   * `lastUserAt` is the timestamp of the last message the user *typed*. Every
   * other kind of utterance (opener, video reaction, budget notice, the nudge
   * itself) deliberately does not count: if they did, the cat would keep
   * resetting its own silence clock and never nudge anyone.
   */
  function nudgeDue(lastUserAt, nowMs) {
    var last = Number(lastUserAt);
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!Number.isFinite(last) || last <= 0) return false;
    // A clock that jumped backwards must not park the user in "quiet forever".
    if (last > now) return false;
    return now - last >= NUDGE_AFTER_MS;
  }

  /**
   * One step of the silence nudge, as a pure transition.
   *
   * The page calls this from its 400ms tick and acts on the result, instead of
   * owning a second timer. That choice is what makes the behaviour testable:
   * everything that decides whether the cat speaks lives here and can be run
   * against a fake clock, while the content script keeps only the three things
   * that touch the DOM (say the line, set the face, tell the tracker it is
   * paused).
   *
   * `current` = { lastUserAt, active, nextAt }; returns the next state plus
   * whether to speak now. Every off-switch — either user setting, or a hidden
   * page — collapses the run to inactive rather than suspending it, so a tab
   * left in the background never accumulates a backlog of lines to dump when
   * it is looked at again.
   *
   * `lastUserAt` comes back out because one input can move it: a clock that
   * jumped backwards. The caller stores whatever it is handed instead of
   * deciding that case itself.
   */
  function nudgeStep(current, nowMs, flags) {
    var state = current && typeof current === 'object' ? current : {};
    var on = !!(flags && flags.enabled && flags.proactive && flags.visible);
    var last = Number(state.lastUserAt);
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    var active = !!state.active;
    var nextAt = Number(state.nextAt);
    function out(isActive, deadline, speak, lastUserAt) {
      return { active: isActive, nextAt: deadline, speak: speak, lastUserAt: lastUserAt };
    }
    if (!on || !Number.isFinite(last) || last <= 0) {
      return out(false, 0, false, last);
    }
    // The clock went backwards: restart the silence window from here rather
    // than waiting for a deadline that is now in the past forever.
    if (last > now) return out(false, now + NUDGE_AFTER_MS, false, now);
    if (!active) {
      if (!nudgeDue(last, now)) return out(false, last + NUDGE_AFTER_MS, false, last);
      return out(true, now + NUDGE_GAP_MS, true, last);
    }
    if (!Number.isFinite(nextAt) || nextAt <= 0 || now >= nextAt) {
      return out(true, now + NUDGE_GAP_MS, true, last);
    }
    return out(true, nextAt, false, last);
  }

  /**
   * The nudge's whole lifecycle, so the page only has to supply a clock, three
   * getters and two DOM callbacks.
   *
   * Splitting it this way is what makes the brief testable: the tests drive this
   * object with a fake clock and the exact call order the page uses (`tick()` on
   * every tracker step, `userSpoke()` from sendMessage), which is the same code
   * that runs in the browser — not a re-implementation of it.
   *
   * It owns no timer on purpose. The page already ticks every 400ms, so a
   * deadline checked there can be at most one tick late, and a background tab
   * cannot leave a timer firing at an empty room.
   */
  function createNudgeMachine(options) {
    var opts = options || {};
    /** Read an injectable dependency, falling back to a fixed answer. */
    function dep(name, fallback) {
      return typeof opts[name] === 'function' ? opts[name] : function () { return fallback; };
    }
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var isEnabled = dep('enabled', true);
    var isProactive = dep('proactive', true);
    var isVisible = dep('visible', true);
    var onSpeak = dep('onSpeak', undefined);
    var onStop = dep('onStop', undefined);

    var lastUserAt = Number(opts.lastUserAt);
    if (!Number.isFinite(lastUserAt) || lastUserAt <= 0) lastUserAt = now();
    var state = { active: false, nextAt: 0 };

    /** Clear the run; `onStop` fires only when something was actually running. */
    function settle(active, nextAt) {
      var wasActive = state.active;
      state.active = !!active;
      state.nextAt = Number(nextAt) || 0;
      if (wasActive && !state.active) onStop();
    }

    function tick() {
      var next = nudgeStep({ lastUserAt: lastUserAt, active: state.active, nextAt: state.nextAt }, now(), {
        enabled: !!isEnabled(),
        proactive: !!isProactive(),
        visible: !!isVisible(),
      });
      if (Number.isFinite(next.lastUserAt) && next.lastUserAt > 0) lastUserAt = next.lastUserAt;
      // Speak before the bookkeeping callback: the page's `onStop` puts the
      // resting face back, and a run that ends on the same tick it speaks would
      // otherwise be wiped a frame later.
      if (next.speak && next.active) onSpeak();
      settle(next.active, next.nextAt);
    }

    return {
      isActive: function () { return !!state.active; },
      nextAt: function () { return state.nextAt; },
      lastUserAt: function () { return lastUserAt; },
      tick: tick,
      /** The user answered: end the run and restart the silence window. */
      userSpoke: function () {
        lastUserAt = now();
        settle(false, 0);
      },
      /** Reset the silence window without claiming the user spoke. */
      restart: function () {
        lastUserAt = now();
        settle(false, 0);
      },
      /** Page hidden or shutting down: end the run, keep the silence window. */
      stop: function () {
        settle(false, 0);
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* chat history                                                      */
  /* ---------------------------------------------------------------- */

  var MESSAGE_ROLES = { assistant: true, user: true, sys: true, err: true };

  /** Coerce one persisted message into a shape the panel can render. */
  function normalizeMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var role = MESSAGE_ROLES[raw.role] ? raw.role : '';
    var content = typeof raw.content === 'string' ? cleanText(raw.content, MAX_MESSAGE_CHARS) : '';
    if (!role || !content) return null;
    var meta = typeof raw.meta === 'string' ? cleanText(raw.meta, 120) : '';
    var at = Number(raw.at);
    var message = { role: role, content: content };
    if (meta) message.meta = meta;
    // Which face led this line. Unknown ids are dropped rather than stored, so
    // a renamed emotion cannot leave a dead reference in saved history.
    if (role === 'assistant' && typeof raw.emotion === 'string' && EMOTION_IDS.indexOf(raw.emotion) >= 0) {
      message.emotion = raw.emotion;
    }
    message.at = Number.isFinite(at) && at > 0 ? Math.round(at) : 0;
    return message;
  }

  /** Coerce one persisted session; returns null when nothing useful remains. */
  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = typeof raw.id === 'string' ? raw.id.slice(0, 64) : '';
    if (!id) return null;
    var messages = [];
    var list = Array.isArray(raw.messages) ? raw.messages : [];
    for (var i = 0; i < list.length; i += 1) {
      var message = normalizeMessage(list[i]);
      if (message) messages.push(message);
    }
    // Only conversations with real content are worth keeping.
    var hasDialogue = messages.some(function (item) {
      return item.role === 'user' || item.role === 'assistant';
    });
    if (!hasDialogue) return null;
    if (messages.length > MAX_SESSION_MESSAGES) messages = messages.slice(-MAX_SESSION_MESSAGES);
    var startedAt = Number(raw.startedAt);
    var endedAt = Number(raw.endedAt);
    var last = messages[messages.length - 1];
    return {
      id: id,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.round(startedAt) : (last && last.at) || Date.now(),
      endedAt: Number.isFinite(endedAt) && endedAt > 0 ? Math.round(endedAt) : (last && last.at) || Date.now(),
      emotionTally: normalizeEmotionTally(raw.emotionTally),
      messages: messages,
    };
  }

  /**
   * Conversations are ordered by when they were started, not by their last
   * message: the list stays put while you keep chatting in an older one.
   * `endedAt` only breaks ties between sessions created in the same ms.
   */
  function byStartedAtDesc(a, b) {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return b.endedAt - a.endedAt;
  }

  /** Newest first, deduped by id, capped. */
  function normalizeHistory(raw) {
    var list = Array.isArray(raw) ? raw : [];
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var session = normalizeSession(list[i]);
      if (!session || seen[session.id]) continue;
      seen[session.id] = true;
      out.push(session);
      if (out.length >= MAX_HISTORY_SESSIONS) break;
    }
    out.sort(byStartedAtDesc);
    return out;
  }

  /** Add (or replace) a session, keeping the creation-time order and the cap. */
  function addSessionToHistory(history, session) {
    var clean = normalizeSession(session);
    if (!clean) return normalizeHistory(history);
    var rest = normalizeHistory(history).filter(function (item) { return item.id !== clean.id; });
    return [clean].concat(rest).sort(byStartedAtDesc).slice(0, MAX_HISTORY_SESSIONS);
  }

  function removeSessionFromHistory(history, id) {
    return normalizeHistory(history).filter(function (item) { return item.id !== id; });
  }

  /** Short label for the history list: creation time + a hint of what was discussed. */
  function describeSession(session) {
    if (!session) return '';
    // The label matches the list order, so the top row is always the newest
    // conversation rather than the one that happened to be touched last.
    var startedAt = Number(session.startedAt) || Number(session.endedAt) || Date.now();
    var date = new Date(startedAt);
    var pad = function (value) { return String(value).padStart(2, '0'); };
    var stamp = pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
      pad(date.getHours()) + ':' + pad(date.getMinutes());
    var messages = Array.isArray(session.messages) ? session.messages : [];
    var first = null;
    for (var i = 0; i < messages.length; i += 1) {
      if (messages[i].role === 'user' || messages[i].role === 'assistant') {
        first = messages[i];
        break;
      }
    }
    var hint = first ? cleanText(first.content, 24) : '';
    var count = messages.filter(function (item) {
      return item.role === 'user' || item.role === 'assistant';
    }).length;
    return stamp + (hint ? ' · ' + hint : '') + (count ? ' · ' + count + ' 条' : '');
  }

  /** FNV-1a, base36. Used only for a stable local video fingerprint. */
  function fnv1a(text) {
    var hash = 0x811c9dc5;
    var value = String(text || '');
    for (var i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Incremental SSE parser. Feed decoded text chunks in any splitting; get
   * complete { event, data } records back. Handles CRLF and multi-line data.
   */
  function createSseParser() {
    var buffer = '';

    function parseBlock(block) {
      var lines = block.replace(/\r/g, '').split('\n');
      var event = 'message';
      var data = [];
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('event:') === 0) {
          event = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (data.length === 0) return null;
      return { event: event, data: data.join('\n') };
    }

    return {
      push: function (chunk) {
        buffer = (buffer + (chunk || '')).replace(/\r\n/g, '\n');
        var out = [];
        var index = buffer.indexOf('\n\n');
        while (index >= 0) {
          var block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          var parsed = parseBlock(block);
          if (parsed) out.push(parsed);
          index = buffer.indexOf('\n\n');
        }
        return out;
      },
      flush: function () {
        var block = buffer;
        buffer = '';
        var parsed = block.trim() ? parseBlock(block) : null;
        return parsed ? [parsed] : [];
      },
    };
  }

  function cleanText(value, maxLength) {
    var text = typeof value === 'string' ? value : '';
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  function buildAnalyzeBody(input) {
    var source = input || {};
    var hashtags = Array.isArray(source.hashtags) ? source.hashtags : [];
    var recent = Array.isArray(source.recentReactions) ? source.recentReactions : [];
    var image = source.image && typeof source.image.data === 'string' ? source.image : null;
    // '' means the duration is unknown (live stream, video not loaded yet).
    // The key is then omitted rather than sent empty: the server schema is a
    // strict enum, so '' would fail validation and the reaction would be lost.
    var bucket = videoBucket(source.videoDuration);
    return {
      requestId: source.requestId || uuid(),
      app: 'douyin',
      tone: TONE,
      // Clamped to the server's schema ceiling. A long video with repeats keeps
      // accumulating (dwellSeconds + n * repeatDwellSeconds), so at the largest
      // settings the third line already exceeds 15 minutes; sending that raw
      // value returned 422 and the whole reaction was dropped.
      dwellMs: Math.min(MAX_DWELL_MS, Math.max(0, Math.round(Number(source.dwellMs) || 0))),
      video: { fingerprint: cleanText(source.fingerprint, 180) },
      ocr: {
        text: cleanText(source.ocrText, 2000),
        caption: cleanText(source.caption, 300),
        hashtags: hashtags
          .map(function (tag) { return cleanText(String(tag).replace(/^#/, ''), 50); })
          .filter(Boolean)
          .slice(0, 10),
      },
      images: image ? [{ mime: 'image/jpeg', data: image.data }] : [],
      recentReactions: recent
        .map(function (text) { return cleanText(text, 80); })
        .filter(Boolean)
        .slice(0, 2),
      // The page's own 「广告」 chip, read from the DOM. A hard signal that the
      // service can trust more than anything the model infers from pixels.
      adLabel: !!source.adLabel,
      // A second reaction to the same long video, not a new video.
      repeat: !!source.repeat,
      // 'short' | 'medium' | 'long' — a bucket, never the raw seconds. See
      // videoBucket(): the model must not get a number it can quote back.
      ...(bucket ? { videoBucket: bucket } : {}),
    };
  }

  /* ---------------------------------------------------------------- */
  /* opening line                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * First thing the cat says when you land on a page. Half greeting, half
   * tease, in the same 拆台 tone as the rest of the persona.
   *
   * Every line ends in 喵 and every line is `greet`: this is the hello, not a
   * reaction to the video, so it must not be driven by content detection.
   */
  var OPENERS = [
    '又来刷视频啊，让我来看看喵',
    '哟，回来了，屏都没凉呢喵',
    '又是你，今天打算刷到几点喵',
    '来了就来了，还装路过喵',
    '开工了，先给我挑点能看的喵',
    '屏幕一亮我就知道是谁喵',
    '别愣着，往上滑啊喵',
    '今天这手速，是打算住这儿喵',
    '先坐好，我陪你刷会儿喵',
    '又来陪我上班了喵',
  ];

  /**
   * Pick an opening line that the user has not seen recently. `recent` is the
   * list of lines already shown this session; falls back to any line once all
   * of them have been used.
   */
  function pickOpener(recent) {
    var seen = Array.isArray(recent) ? recent : [];
    var fresh = OPENERS.filter(function (line) {
      return seen.indexOf(line) === -1;
    });
    var pool = fresh.length > 0 ? fresh : OPENERS;
    var index = Math.floor(Math.random() * pool.length) % pool.length;
    return pool[index];
  }

  /**
   * Clamp the per-conversation emotion counts before they leave the page.
   * Only known ids survive, so a stale or hand-edited entry cannot inflate an
   * arbitrary key, and the payload stays small.
   */
  function normalizeEmotionTally(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (var i = 0; i < EMOTION_IDS.length; i += 1) {
      var id = EMOTION_IDS[i];
      var value = Number(raw[id]);
      if (!Number.isFinite(value) || value <= 0) continue;
      out[id] = Math.min(9999, Math.floor(value));
    }
    return out;
  }

  function buildChatBody(input) {
    var source = input || {};
    var history = Array.isArray(source.history) ? source.history : [];
    var context = source.context && typeof source.context === 'object' ? source.context : {};
    var keywords = Array.isArray(context.keywords) ? context.keywords : [];
    return {
      requestId: source.requestId || uuid(),
      sessionId: source.sessionId || uuid(),
      tone: TONE,
      message: cleanText(source.message, 1000),
      context: {
        summary: cleanText(context.summary, 500),
        keywords: keywords
          .map(function (word) { return cleanText(word, 30); })
          .filter(Boolean)
          .slice(0, 10),
        caption: cleanText(context.caption, 300),
      },
      emotionTally: normalizeEmotionTally(source.emotionTally),
      history: history
        .filter(function (turn) {
          return turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string';
        })
        .map(function (turn) { return { role: turn.role, content: cleanText(turn.content, 2000) }; })
        .filter(function (turn) { return turn.content.length > 0; })
        .slice(-12),
      privacyTextOnly: true,
    };
  }

  root.Buddy = {
    TONE: TONE,
    DEFAULTS: DEFAULTS,
    SETTINGS_VERSION: SETTINGS_VERSION,
    BALL_SIZE_MIN: BALL_SIZE_MIN,
    BALL_SIZE_MAX: BALL_SIZE_MAX,
    // Exported so the tests can hold popup.html's min/max to the same numbers.
    DWELL_MIN: DWELL_MIN,
    DWELL_MAX: DWELL_MAX,
    REPEAT_DWELL_MIN: REPEAT_DWELL_MIN,
    REPEAT_DWELL_MAX: REPEAT_DWELL_MAX,
    COOLDOWN_MIN: COOLDOWN_MIN,
    COOLDOWN_MAX: COOLDOWN_MAX,
    BUBBLE_MIN: BUBBLE_MIN,
    BUBBLE_MAX: BUBBLE_MAX,
    EMOTION_HOLD_MIN: EMOTION_HOLD_MIN,
    EMOTION_HOLD_MAX: EMOTION_HOLD_MAX,
    LIMIT_MINUTES_MIN: LIMIT_MINUTES_MIN,
    LIMIT_MINUTES_MAX: LIMIT_MINUTES_MAX,
    LIMIT_COOLDOWN_MIN: LIMIT_COOLDOWN_MIN,
    LIMIT_COOLDOWN_MAX: LIMIT_COOLDOWN_MAX,
    LIMIT_CLOSE_MIN: LIMIT_CLOSE_MIN,
    LIMIT_CLOSE_MAX: LIMIT_CLOSE_MAX,
    normalizeRepeatDwell: normalizeRepeatDwell,
    DEVICE_ID_RE: DEVICE_ID_RE,
    HISTORY_KEY: HISTORY_KEY,
    MAX_HISTORY_SESSIONS: MAX_HISTORY_SESSIONS,
    MAX_SESSION_MESSAGES: MAX_SESSION_MESSAGES,
    normalizeSettings: normalizeSettings,
    modeConfigured: modeConfigured,
    normalizeServerUrl: normalizeServerUrl,
    normalizeApiBaseUrl: normalizeApiBaseUrl,
    emotionHoldMs: emotionHoldMs,
    bubbleMs: bubbleMs,
    repeatDwellMs: repeatDwellMs,
    dwellGoalMs: dwellGoalMs,
    frameSamplePoints: frameSamplePoints,
    videoBucket: videoBucket,
    makeDeviceId: makeDeviceId,
    uuid: uuid,
    fnv1a: fnv1a,
    cleanText: cleanText,
    normalizeMessage: normalizeMessage,
    normalizeSession: normalizeSession,
    normalizeHistory: normalizeHistory,
    addSessionToHistory: addSessionToHistory,
    removeSessionFromHistory: removeSessionFromHistory,
    describeSession: describeSession,
    createSseParser: createSseParser,
    OPENERS: OPENERS,
    pickOpener: pickOpener,
    LIMIT_KEY: LIMIT_KEY,
    LIMIT_LINES: LIMIT_LINES,
    dayKey: dayKey,
    limitBudgetMs: limitBudgetMs,
    limitCooldownMs: limitCooldownMs,
    limitCloseDelayMs: limitCloseDelayMs,
    normalizeLimitState: normalizeLimitState,
    limitSnapshot: limitSnapshot,
    limitAfterShutdown: limitAfterShutdown,
    limitCredit: limitCredit,
    pickLimitLine: pickLimitLine,
    // Silence nudge + budget announcement. Constants are exported (and
    // documented as fixed) so the page, the tests and the site copy cannot
    // drift apart on what "5 minutes" and "5 seconds" mean.
    NUDGE_AFTER_MS: NUDGE_AFTER_MS,
    NUDGE_GAP_MS: NUDGE_GAP_MS,
    BUDGET_LINES: BUDGET_LINES,
    NUDGE_LINES: NUDGE_LINES,
    pickBudgetLine: pickBudgetLine,
    pickNudgeLine: pickNudgeLine,
    nudgeDue: nudgeDue,
    nudgeStep: nudgeStep,
    createNudgeMachine: createNudgeMachine,
    EMOTION_IDS: EMOTION_IDS,
    normalizeEmotionTally: normalizeEmotionTally,
    buildAnalyzeBody: buildAnalyzeBody,
    buildChatBody: buildChatBody,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
