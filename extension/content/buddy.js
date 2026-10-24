/*
 * 喵喵陪你刷 — floating ball content script.
 *
 * Watches the currently playing video on Douyin. After the user stays on the
 * same video for `dwellSeconds`, it asks the local server for a one-line
 * reaction and (optionally) opens the chat panel.
 *
 * Runs in an isolated world together with shared/core.js (window.Buddy).
 */
(function () {
  'use strict';

  var Buddy = window.Buddy;
  if (!Buddy || window.__smBuddyLoaded) return;
  window.__smBuddyLoaded = true;

  var Emotions = window.BuddyEmotions || window.CatEmotions || null;
  var EMOTION_DEFAULT = Emotions ? Emotions.DEFAULT : 'greet';

  var POS_KEY = 'smPosition';
  // Remembers the opening lines already shown, so refreshing the page a few
  // times in a row does not keep saying the same thing.
  var OPENER_KEY = 'smOpenerSeen';

  var settings = Buddy.normalizeSettings({});
  var position = null;
  var state = {
    host: null,
    root: null,
    ball: null,
    ring: null,
    bubble: null,
    bubbleTimer: 0,
    panel: null,
    panelOpen: false,
    messages: [],
    sessionStartedAt: Date.now(),
    history: [],
    historyOpen: false,
    videoCount: 0,
    historyReady: false,
    wasDisabled: false,
    // Per-conversation emotion counts, reported to the server so it can fill
    // neutral turns with whichever face has been shown least.
    emotionTally: Object.create(null),
    // The silence clock and the nag's run state are owned by the `nudge` module
    // below (backed by `Buddy.createNudgeMachine`) rather than kept here. Two
    // copies of "when did the user last speak" is exactly how the cat ends up
    // resetting its own timer and never nagging.
    // Budget announcement is once per conversation, not per page load: a
    // refresh must not make it say the same thing twice.
    budgetAnnounced: false,
    sessionDirty: false,
    saveTimer: 0,
    streaming: false,
    port: null,
    sessionId: Buddy.uuid(),
    lastAnalysis: null,
    recentReactions: [],
    cooldownUntil: 0,
    emotion: EMOTION_DEFAULT,
    emotionTimer: 0,
    emotionSwapTimer: 0,
    emotionLastAt: 0,
    disc: null,
    emotionImg: null,
    grip: null,
  };

  /* ---------------------------------------------------------------- */
  /* storage                                                           */
  /* ---------------------------------------------------------------- */

  function loadStored() {
    try {
      chrome.storage.local.get(['settings', POS_KEY, Buddy.HISTORY_KEY, OPENER_KEY], function (data) {
        if (!data) return;
        if (data.settings) settings = Buddy.normalizeSettings(data.settings);
        position = isPosition(data[POS_KEY]) ? data[POS_KEY] : null;
        state.history = Buddy.normalizeHistory(data[Buddy.HISTORY_KEY]);
        openerHistory = Array.isArray(data[OPENER_KEY]) ? data[OPENER_KEY] : [];
        state.historyReady = true;
        ui.mount();
        tracker.settingsChanged();
        ui.applySettings();
        // Started here, not at boot: the limiter needs the *stored* settings
        // (budget/cooldown), and its first read is async — running it before
        // this callback would judge the page against the defaults instead.
        // It also needs the UI mounted, since the warning is shown in a bubble.
        //
        // The opener is chained to the limiter on purpose: if the budget is
        // already gone (or we are in the cooldown), greeting the user and then
        // closing the tab one second later reads as two minds, not one.
        limiter.start(sayOpener);
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.settings) {
          settings = Buddy.normalizeSettings(changes.settings.newValue);
          tracker.settingsChanged();
          ui.applySettings();
        }
        if (changes[Buddy.HISTORY_KEY]) {
          // Another tab may have archived or pruned sessions; mirror it. The
          // open list is repainted too, otherwise the panel keeps showing a
          // stale set until it is reopened.
          state.history = Buddy.normalizeHistory(changes[Buddy.HISTORY_KEY].newValue);
          if (state.historyOpen) ui.paintHistory();
        }
      });
    } catch (error) {
      // Extension was reloaded while the page stayed open.
      console.warn('[喵喵陪你刷] context invalidated:', error && error.message);
    }
  }

  function isPosition(value) {
    return value && typeof value.x === 'number' && typeof value.y === 'number' &&
      Number.isFinite(value.x) && Number.isFinite(value.y);
  }

  function savePosition(x, y) {
    position = { x: x, y: y };
    try {
      chrome.storage.local.set({ [POS_KEY]: position });
    } catch (_error) { /* ignore */ }
  }

  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = window.setTimeout(function () {
        if (done) return;
        done = true;
        resolve(fallback);
      }, ms);
      promise.then(function (value) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve(value);
      }, function () {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  function sendBg(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { code: 'CONTEXT', message: '插件已更新，刷新页面后再用', retryable: true } });
            return;
          }
          resolve(response || { ok: false, error: { code: 'EMPTY', message: '插件没有响应', retryable: true } });
        });
      } catch (error) {
        resolve({ ok: false, error: { code: 'CONTEXT', message: '插件已更新，刷新页面后再用', retryable: true } });
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* video detection + dwell                                           */
  /* ---------------------------------------------------------------- */

  function visibleArea(element) {
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 0;
    var width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    var height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return Math.max(0, width) * Math.max(0, height);
  }

  function pickVideo() {
    var videos = Array.prototype.slice.call(document.querySelectorAll('video'));
    var usable = videos.filter(function (video) {
      return (video.videoWidth > 0 || video.videoHeight > 0) && visibleArea(video) > 0;
    });
    if (usable.length === 0) return null;
    usable.sort(function (a, b) {
      var playing = (b.paused ? 0 : 1) - (a.paused ? 0 : 1);
      if (playing !== 0) return playing;
      return visibleArea(b) - visibleArea(a);
    });
    return usable[0];
  }

  /**
   * Caption text for identity only — cheap and scoped, no layout.
   *
   * `readCaption()` picks the largest VISIBLE description, which costs a
   * `getBoundingClientRect()` plus an `innerText` per candidate, and it scans
   * the whole document. `videoKey()` asks for something on every 400ms tick,
   * so the whole-document scan was paid 150 times a minute.
   *
   * Identity only needs "did THIS item's text change", so this walks the
   * playing video's own feed item instead. Scoping matters for correctness as
   * much as cost: Douyin preloads the next item's caption into the DOM, and a
   * document-wide read would change the key when that offscreen preload
   * lands — resetting the dwell clock on a video the user is still watching.
   */
  var DESC_SELECTOR = '[data-e2e="video-desc"], [data-e2e="feed-video-desc"]';

  function readDescText(node) {
    return (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function captionSignature(video) {
    var scope = video && video.closest
      ? video.closest('article, li, [data-e2e="feed-item"], [data-e2e="video-item"]')
      : null;

    var parts = [];
    if (scope) {
      var owned = scope.querySelectorAll(DESC_SELECTOR);
      for (var i = 0; i < owned.length; i += 1) parts.push(readDescText(owned[i]));
    }
    // No item wrapper, or the caption rendered outside it: fall back to the
    // first description in document order. Returning '' here instead would
    // make every blob: video share one key, so the feed would look like a
    // single endless video and repeats would fire on every advance.
    if (parts.length === 0) {
      var first = document.querySelector(DESC_SELECTOR);
      if (first) parts.push(readDescText(first));
    }
    return parts.join('\u0001');
  }

  /**
   * Douyin often reuses a single <video> with a blob: URL across feed items,
   * so a blob src alone cannot identify the current video. Combine it with the
   * caption / poster, which do change when the feed advances.
   */
  function videoKey(video) {
    if (!video) return '';
    var src = video.currentSrc || video.src || '';
    if (src && src.indexOf('blob:') !== 0 && src.indexOf('data:') !== 0) return src;

    var desc = captionSignature(video).slice(0, 120);
    var poster = video.getAttribute('poster') || '';
    var link = video.closest ? video.closest('[href*="/video/"], article, li') : null;
    var href = link && link.getAttribute ? link.getAttribute('href') || '' : '';
    if (desc || poster || href) return ['blob', href, poster, desc].join('|');
    return 'src|' + src + '|' + document.title;
  }

  var tracker = (function () {
    var currentKey = '';
    var accumulated = 0;
    var lastTick = 0;
    // How many reactions this viewing of the video has already produced.
    // Lives only while the video is on screen, so scrolling away and back
    // restarts the clock and behaves like the first visit.
    var firedCount = Object.create(null);
    // Last-seen dwell settings, so cosmetic changes can be ignored.
    var lastFirst = Number(settings.dwellSeconds);
    var lastRepeat = Number(settings.repeatDwellSeconds);
    var timer = 0;

    function reset(key) {
      currentKey = key || '';
      accumulated = 0;
    }

    function tick() {
      var now = performance.now();
      var delta = lastTick ? Math.min(now - lastTick, 1000) : 0;
      lastTick = now;

      // Douyin re-renders aggressively; re-attach if either of our roots got
      // detached. Checking only the ball would leave the chat log writing into
      // an orphaned node, which looks exactly like "replies stopped appearing".
      if (state.host && ui.needsRemount()) ui.mount();

      if (document.visibilityState !== 'visible') {
        return;
      }

      // Runs before the video checks: the silence clock is about the user, not
      // about whether a video happens to be on screen.
      nudge.tick();

      var video = pickVideo();
      if (!video) {
        if (currentKey) reset('');
        // No video on screen: nothing those frames belong to any more.
        frames.reset();
        ui.setProgress(0);
        return;
      }

      var key = videoKey(video);
      if (key !== currentKey) {
        // Leaving a video ends its viewing: the next visit starts over.
        if (currentKey) delete firedCount[currentKey];
        // Frames belong to the video they came from; a new video starts clean.
        frames.reset();
        reset(key);
        return;
      }

      // Paused, buffering, or being nagged: keep what we have, stop counting.
      // The nudge case is a pause, not a reset — see the module comment: the
      // user keeps the time they had already watched.
      var playing = !video.paused && !video.ended && video.readyState >= 2;
      if (!playing || delta <= 0 || nudge.isActive()) {
        var shownGoal = Buddy.dwellGoalMs(settings, firedCount[key] || 0);
        if (shownGoal > 0) ui.setProgress(Math.min(1, accumulated / shownGoal));
        return;
      }

      // Watch-time budget before the dwell logic: it has to keep counting even
      // when repeats are switched off (goal 0 below would return early and the
      // limiter would never fire on that setting).
      limiter.add(delta);

      // Next line waits `dwellSeconds` on the first pass over a video and
      // `repeatDwellSeconds` after that. A goal of 0 means repeats are off.
      var fired = firedCount[key] || 0;
      var goal = Buddy.dwellGoalMs(settings, fired);
      if (goal <= 0) {
        ui.setProgress(0);
        return;
      }

      // Sample while it plays, so the sheet spans the watch instead of freezing
      // on one instant. Tied to real playback, not to wall-clock time.
      frames.grab(video, frames.gapFor(goal));

      accumulated += delta;
      ui.setProgress(Math.min(1, accumulated / goal));

      if (accumulated < goal) return;

      // Cooldown is a retry backoff after a failed call, not a per-video
      // throttle: every video deserves its own line in the chat log.
      if (Date.now() < state.cooldownUntil) return;

      // The next interval starts here, not from the video's start, so the ring
      // refills at the repeat rate instead of re-running the first-visit wait.
      firedCount[key] = fired + 1;
      accumulated = 0;
      ui.setProgress(0);
      onDwell(video, key, fired);
    }

    return {
      start: function () {
        if (timer) return;
        timer = window.setInterval(tick, 400);
        document.addEventListener('visibilitychange', function () {
          lastTick = 0;
        });
      },
      settingsChanged: function () {
        // Only the two dwell timings affect the counters; a cosmetic change
        // (ball size, bubble seconds) must not restart the ring.
        var nextFirst = Number(settings.dwellSeconds);
        var nextRepeat = Number(settings.repeatDwellSeconds);
        if (nextFirst === lastFirst && nextRepeat === lastRepeat) return;
        lastFirst = nextFirst;
        lastRepeat = nextRepeat;
        firedCount = Object.create(null);
        reset('');
      },
      stop: function () {
        window.clearInterval(timer);
        timer = 0;
      },
    };
  })();

  /* ---------------------------------------------------------------- */
  /* watch-time budget                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Counts only the time a video is actually playing on a visible page, then
   * closes the tab when the user's budget is gone.
   *
   * Why a separate module from `tracker`: the tracker answers "how long on
   * this one video", this one answers "how long today". They share the tick
   * but not the state, and the limiter keeps working when repeats are off.
   *
   * Three failure modes this is built to avoid:
   *  - counting while paused or in a background tab (the user is not watching,
   *    so nothing should be spent);
   *  - closing without warning (the line is shown for `limitCloseSeconds`
   *    first, and the transcript records it);
   *  - closing again and again after the budget resets (that is what the
   *    cooldown is for: reopen inside it and the page is closed immediately).
   */
  var limiter = (function () {
    var started = false;
    var closeTimer = 0;
    // True once this page has announced its shutdown, so a slow tab close
    // cannot produce the same line twice.
    var announced = false;
    var recentLines = [];
    // Playback time seen but not yet handed to the service worker. Ticks are
    // 400ms apart and the worker may be starting up, so a few deltas can pile
    // up; batching them also keeps the message rate down.
    var unspentMs = 0;

    /**
     * Report playback time to the service worker, which owns the shared
     * ledger. The page never writes `smLimit` itself: two open tabs would read
     * the same base and one would erase the other's time.
     */
    function charge() {
      if (announced || unspentMs <= 0) return;
      var delta = Math.round(unspentMs);
      unspentMs = 0;
      sendBg({ type: 'sm:limitTick', deltaMs: delta }).then(function (response) {
        if (!response || !response.ok) {
          // The worker is not answering (extension reloaded, or it crashed).
          // Keep the time so a later tick can hand it over.
          unspentMs += delta;
          return;
        }
        if (response.over) {
          sayAndClose('over');
        } else if (response.inCooldown) {
          // Another tab hit the limit first and stamped the cooldown. This tab
          // was open the whole time, so it must not say the 「还敢点开」line:
          // the user did not reopen anything. The race is still a shutdown for
          // this tab, so it gets the same "time is up" line and closes too.
          sayAndClose('over');
        }
      });
    }

    function sayAndClose(kind) {
      if (announced) return;
      announced = true;
      // The tab's last words are the shutdown line. A nudge timer firing during
      // the close countdown would put "理我一下" on screen seconds before the
      // page disappears, and a second bubble would cover the real message.
      nudge.stop();
      var line = Buddy.pickLimitLine(kind, recentLines);
      if (kind === 'nag') {
        // The line has to quote the cap the user actually chose; the template
        // keeps the number out of the pool so a settings change cannot leave a
        // stale "10" in the transcript.
        line = line.replace('{count}', String(settings.nudgeLimitCount));
      }
      recentLines = [line].concat(recentLines).slice(0, 4);
      // 生气 fits "you were told to stop"; the tab is going away anyway, so
      // the face only needs to be legible for a few seconds.
      if (Emotions) ui.setEmotion('angry', { force: true, holdMs: 0, source: 'limit' });
      ui.appendNotice(line, 'angry', 'limit');
      ui.showReaction(line);
      // The transcript is about to disappear with the tab; save it now so the
      // record survives in 记录.
      ui.persistSession();

      // Stamp the cooldown as soon as the line is shown, not when the timer
      // fires: a manual close during the countdown must still count, and the
      // page can vanish before our timer runs.
      //
      // The worker owns this and treats it as idempotent. The credit path
      // already stamps when the budget runs out, but a page that *loads* with
      // the budget gone never charges anything — without this call that path
      // would close the tab and leave no cooldown behind.
      if (kind === 'over' || kind === 'nag') sendBg({ type: 'sm:limitShutdown', reason: kind });

      var delay = Buddy.limitCloseDelayMs(settings);
      closeTimer = window.setTimeout(function () {
        sendBg({ type: 'sm:closeTab' }).then(function (response) {
          if (response && response.ok) return;
          // The background refused or the tab is already gone. Closing from
          // the page itself only works for script-opened tabs, so this is a
          // best effort; say nothing rather than leave a dead bubble.
          try { window.close(); } catch (_error) { /* not script-opened */ }
          // Still here means neither close worked. Undo the freeze the nudge
          // put on the tracker: it is waiting for a shutdown that is not
          // coming, and a frozen ring plus a cat that never speaks again is a
          // worse failure than the missed shutdown.
          nudge.release();
        });
      }, delay);
    }

    return {
      /**
       * Load the persisted total and decide whether this page may stay open.
       * `onAllowed` runs only when the page is fine to use — the opener must
       * not greet someone who is about to be thrown out again.
       */
      start: function (onAllowed) {
        if (started) return;
        started = true;
        // Ask the worker for the shared state instead of reading storage: it
        // holds the authority and also applies the day rollover.
        sendBg({ type: 'sm:limitState' }).then(function (response) {
          if (!response || !response.ok) {
            // Without the worker there is no reliable budget. Let the page work
            // rather than block browsing on a broken extension.
            if (onAllowed) onAllowed();
            return;
          }
          var snap = Buddy.limitSnapshot(response.state, Date.now(), settings);
          if (snap.disabled) {
            if (onAllowed) onAllowed();
            return;
          }
          if (snap.inCooldown) {
            // Reopened too soon: one line, then the tab goes away again.
            sayAndClose('back');
            return;
          }
          if (snap.overBudget) {
            sayAndClose('over');
            return;
          }
          if (onAllowed) onAllowed();
        });
      },

      /**
       * Add playback time. Called from the tracker tick with the real elapsed
       * ms, which is already zero when the page is hidden or the video is
       * paused — the caller only passes real playback time.
       *
       * The bump is local and cheap; handing it to the worker is what may be
       * asynchronous, and any of it that fails to send is kept for next time.
       */
      add: function (deltaMs) {
        if (announced || !(deltaMs > 0)) return;
        if (Buddy.limitBudgetMs(settings) <= 0) return;
        unspentMs += deltaMs;
        charge();
      },

      /** Hand over whatever is still unspent before the page goes away. */
      flush: function () {
        if (!started || announced) return;
        charge();
      },

      cancel: function () {
        window.clearTimeout(closeTimer);
        closeTimer = 0;
        announced = false;
      },

      /**
       * The nudge cap was reached. This is a real shutdown, not a pause: the
       * page closes and the cooldown is stamped, so reopening inside it is
       * turned away by `start()` with the 「还敢点开」 line.
       *
       * The watch time already spent is *not* refunded (the worker stamps with
       * `limitAfterNag`), so ignoring the cat cannot be used to farm a fresh
       * daily budget — the cap adds a limit, it does not replace one.
       *
       * Gated on `limitEnabled` deliberately: that switch is the user's
       * permission for this extension to close tabs. With it off the nudge keeps
       * talking instead of silently acquiring a new power.
       */
      closeForNudge: function () {
        if (announced || !settings.limitEnabled) return;
        sayAndClose('nag');
      },
    };
  })();

  /* ---------------------------------------------------------------- */
  /* silence nudge                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Nags the user when they have stopped talking to the cat.
   *
   * Five minutes of silence (fixed), then one line every five seconds (fixed)
   * until they type something. The site states both numbers as non-configurable
   * and the constants live in core.js next to the limit lines, so there is one
   * place to read them.
   *
   * While the nudge is running the tracker must not accumulate dwell time.
   * Two reasons, and the second is the one that matters:
   *  - otherwise the cat nags and then, mid-nag, reacts to a video the user is
   *    being told off for watching — two voices talking at once;
   *  - the ring visually claims to be measuring attention, and it cannot do
   *    that while the cat is deliberately interrupting that attention.
   * The accumulator is frozen, not cleared: the user gets back the time they
   * had already watched and the ring resumes where it stopped.
   *
   * All of the timing lives in `Buddy.createNudgeMachine`, which the tests drive
   * with a fake clock; this IIFE is only the part that touches the DOM. Not
   * owning a second timer is the point: the machine is stepped from the
   * tracker's existing 400ms tick, so a nag can be at most one tick late and no
   * timer is left running in a tab nobody is watching.
   *
   * `nudge.isActive()` is the single source of truth for the pause. The tracker
   * reads it on every tick, so there is no second flag to keep in sync.
   */
  var nudge = (function () {
    var recent = [];

    var machine = Buddy.createNudgeMachine({
      now: function () { return Date.now(); },
      // Both switches are read on every tick, so flipping either stops the run
      // instead of waiting for the next page load.
      enabled: function () { return !!settings.enabled; },
      proactive: function () { return !!settings.proactive; },
      // Silence only counts while the page is being looked at. A tab in the
      // background is not "ignoring the cat", it is not there, and talking to
      // an empty room every five seconds is pure noise.
      visible: function () { return document.visibilityState === 'visible'; },
      // How many utterances this streak gets before the page is shut down. A
      // getter, so a popup change applies without a reload and switching
      // 到点关视频 off drops the cap immediately: closing pages is that switch's
      // permission, and the nudge must not acquire it on its own.
      cap: function () { return settings.limitEnabled ? settings.nudgeLimitCount : 0; },
      onSpeak: function () {
        var line = Buddy.pickNudgeLine(recent);
        recent = [line].concat(recent).slice(0, Buddy.NUDGE_LINES.length - 1);
        // 嫌弃 is the joke: the cat is annoyed, not hurt. holdMs 0 so the face
        // does not expire back to greet between two nags.
        if (Emotions) ui.setEmotion('annoyed', { force: true, holdMs: 0, source: 'nudge' });
        // A real utterance in the transcript, but not `seed`: unlike the opener
        // it is something that happened in the conversation. `scripted` keeps
        // it out of the model's history (see MAX_SCRIPTED_MESSAGES).
        ui.appendNotice(line, 'annoyed', 'nudge');
        ui.showReaction(line);
      },
      onExhausted: function () {
        // The cap counts this utterance, so the last thing the user reads is
        // the closing line, not one more nag. The machine has already settled
        // its own state before calling this, so the shutdown path can safely
        // call `stop()` without arming the run again.
        limiter.closeForNudge();
      },
      onStop: function () {
        // The face the nagging left behind is not the truth any more. Drop back
        // to the resting greeting without touching the quota (source: 'nudge').
        if (Emotions) ui.setEmotion(EMOTION_DEFAULT, { force: true, holdMs: 0, source: 'nudge' });
      },
    });

    return {
      /** True while the nag is the reason dwell time is frozen. */
      isActive: function () { return machine.isActive(); },
      /** Called on the tracker's 400ms tick, after the visibility gate. */
      tick: function () { machine.tick(); },
      /** The user said something: end the nag and restart the silence clock. */
      resolve: function () { machine.userSpoke(); },
      /** Reset the silence clock without claiming the user spoke. */
      restart: function () { machine.restart(); },
      /** Page hidden or shutting down: end the run. */
      stop: function () { machine.stop(); },
      /** The close failed; give the page back instead of freezing it. */
      release: function () { machine.release(); },
    };
  })();

  /* ---------------------------------------------------------------- */
  /* frame sampling                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Keeps a rolling strip of small frames taken straight off the <video>
   * element, so the model sees how the video moves instead of one frozen
   * instant.
   *
   * Two things this fixes that a `captureVisibleTab` cannot:
   *  - the screenshot includes our own floating ball and the previous bubble,
   *    so the model reads its own last reply off the screen and copies it;
   *  - the whole viewport goes out, comments and avatars included.
   *
   * Frames are taken while the video plays (never by seeking: that would
   * interrupt playback). Only thumbnails are kept, so memory stays flat.
   */
  var frames = (function () {
    var MAX_FRAMES = 8;
    var THUMB_WIDTH = 260;
    var buffer = [];
    var blocked = false;
    var lastAt = 0;

    function reset() {
      buffer.length = 0;
      lastAt = 0;
    }

    function thumbSize(video) {
      var vw = video.videoWidth || 0;
      var vh = video.videoHeight || 0;
      if (vw < 16 || vh < 16) return null;
      var scale = Math.min(1, THUMB_WIDTH / vw);
      return { w: Math.max(1, Math.round(vw * scale)), h: Math.max(1, Math.round(vh * scale)) };
    }

    /**
     * Spacing that makes MAX_FRAMES span the whole dwell window. Without this
     * a fixed gap only covers the last few seconds, so the opening of the
     * video — where most clips put their setup — would never be seen.
     */
    function gapFor(goalMs) {
      var span = Number(goalMs) > 0 ? Number(goalMs) : 4000;
      return Math.max(300, Math.round(span / MAX_FRAMES));
    }

    /** Take one thumbnail, at most every `gapMs`, keeping the last MAX_FRAMES. */
    function grab(video, gapMs) {
      if (blocked || !video) return;
      var now = Date.now();
      if (lastAt && now - lastAt < (gapMs || 400)) return;
      var size = thumbSize(video);
      if (!size) return;
      try {
        var canvas = document.createElement('canvas');
        canvas.width = size.w;
        canvas.height = size.h;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, size.w, size.h);
        // drawImage succeeds even for cross-origin media; the taint only shows
        // up when pixels are read. Checking here keeps the failure cheap and
        // stops us from wasting work on a video that can never be composed.
        ctx.getImageData(0, 0, 1, 1);
      } catch (error) {
        blocked = true;
        buffer.length = 0;
        return;
      }
      lastAt = now;
      buffer.push(canvas);
      if (buffer.length > MAX_FRAMES) buffer.shift();
    }

    /** Indices spread across the buffered window, following the dwell timing. */
    function pickIndices(count) {
      var points = Buddy.frameSamplePoints(count);
      var picked = [];
      for (var i = 0; i < points.length; i += 1) {
        var index = Math.floor(points[i] * buffer.length - 0.0001);
        index = Math.min(buffer.length - 1, Math.max(0, index));
        if (picked.indexOf(index) === -1) picked.push(index);
      }
      return picked;
    }

    function paintCell(ctx, canvas, x, y, order) {
      ctx.drawImage(canvas, x, y);
      // A small ordinal makes the reading order unambiguous; without it the
      // model happily treats the bottom-left frame as the opening shot.
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(x + 4, y + 4, 16, 16);
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(String(order), x + 12, y + 13);
    }

    /**
     * Compose the picked frames into one 2x2 sheet — still a single image, so
     * the request shape and the 400KiB limit do not change.
     * Returns { data, bytes } or null when nothing usable was captured.
     */
    function compose(count) {
      if (buffer.length === 0) return null;
      var picked = pickIndices(count);
      if (picked.length === 0) return null;

      var cell = buffer[picked[0]];
      var sheet = document.createElement('canvas');
      sheet.width = cell.width * 2;
      sheet.height = cell.height * 2;
      var ctx = sheet.getContext('2d');
      if (!ctx) return null;
      // Dark gutter so the four cells stay visually separable.
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, sheet.width, sheet.height);

      for (var i = 0; i < picked.length; i += 1) {
        var x = (i % 2) * cell.width;
        var y = Math.floor(i / 2) * cell.height;
        paintCell(ctx, buffer[picked[i]], x, y, i + 1);
      }

      var qualities = [0.72, 0.58, 0.45];
      for (var q = 0; q < qualities.length; q += 1) {
        var dataUrl;
        try {
          dataUrl = sheet.toDataURL('image/jpeg', qualities[q]);
        } catch (error) {
          blocked = true;
          return null;
        }
        var base64 = dataUrl.indexOf(',') >= 0 ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
        var bytes = Math.round(base64.length * 0.75);
        if (base64 && bytes <= 380 * 1024) return { data: base64, bytes: bytes };
      }
      return null;
    }

    return {
      grab: grab,
      compose: compose,
      reset: reset,
      gapFor: gapFor,
      blocked: function () { return blocked; },
    };
  })();

  /**
   * Wait for the browser to actually paint what we just changed.
   *
   * Bounded on purpose: `requestAnimationFrame` does not fire while the tab is
   * in the background, and an unbounded wait here would leave the overlay
   * hidden — the ball would vanish until the next tick.
   */
  function nextPaint() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        resolve();
      };
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(finish);
      });
      window.setTimeout(finish, 200);
    });
  }

  /**
   * One image for the request: sampled frames when the page allows reading
   * pixels, otherwise a whole-tab shot with our own overlay hidden.
   */
  async function captureShot() {
    var composed = frames.compose(4);
    if (composed) return { ok: true, image: composed, source: 'frames' };

    ui.setCaptureHidden(true);
    await nextPaint();
    try {
      return await withTimeout(sendBg({ type: 'sm:capture' }), 3500, { ok: false });
    } finally {
      ui.setCaptureHidden(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* OCR-ish text from the page                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Caption + hashtags only.
   *
   * Split out from `readScreenText` because `videoKey()` needs this on EVERY
   * tick (a blob: video's src never identifies the clip) while the ad-label
   * lookup is only needed once, at the moment a reaction is built. Keeping
   * them together meant the expensive wildcard selector below ran 150 times a
   * minute and the result was thrown away.
   */
  function readCaption() {
    var caption = '';
    var hashtags = [];

    var descs = document.querySelectorAll('[data-e2e="video-desc"], [data-e2e="feed-video-desc"]');
    if (descs.length > 0) {
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < descs.length; i += 1) {
        var area = visibleArea(descs[i]);
        if (area > bestArea) {
          bestArea = area;
          best = descs[i];
        }
      }
      if (best) {
        caption = (best.innerText || '').trim();
        var links = best.querySelectorAll('a');
        for (var j = 0; j < links.length; j += 1) {
          var text = (links[j].textContent || '').trim();
          if (text.indexOf('#') === 0) hashtags.push(text.replace(/^#/, ''));
        }
      }
    }

    if (!caption) {
      var meta = document.querySelector('meta[name="description"]');
      caption = meta ? (meta.getAttribute('content') || '').trim() : '';
    }

    if (hashtags.length === 0) {
      var tags = caption.match(/#[^\s#]+/g) || [];
      hashtags = tags.map(function (tag) { return tag.replace(/^#/, ''); }).slice(0, 10);
    }

    return {
      caption: Buddy.cleanText(caption, 300),
      hashtags: hashtags.slice(0, 10),
    };
  }

  /**
   * Everything a reaction needs: text plus the ad chip.
   *
   * Only called from `onDwell()` — once per reaction, not once per tick. The
   * ad-label lookup is a wildcard attribute selector that scales with page
   * size, so it must not sit on the 400ms path.
   */
  function readScreenText(video) {
    var screen = readCaption();
    screen.adLabel = readAdLabel(video);
    return screen;
  }

  /**
   * Douyin prints an 「广告」 chip on promotional items. Reading that chip is
   * far more reliable than guessing from the caption, so it is treated as a
   * hard signal: the page itself is labelling the item.
   *
   * Matched on exact short text only — a caption that merely contains the word
   * 广告 must not count, which is why this looks at small standalone elements
   * rather than at the whole description block.
   */
  var AD_LABEL_TEXT = /^(广告|赞助|推广|品牌广告|商业推广|广告创意)$/;

  // Named contracts for the chip. These are specific enough that a document
  // scan only ever matches a handful of nodes, so they stay global: losing
  // recall here would silently stop ad detection.
  var AD_CHIP_SELECTOR =
    '[data-e2e*="ad" i], [class*="ad-tag" i], [class*="adTag" i], [class*="ad-label" i], ' +
    '[data-e2e="video-tag"], [class*="video-tag" i]';

  // Last-resort guess at a generic container class. `[class*="tag" i] span`
  // matches a span under ANY element whose class contains "tag", which is
  // thousands of nodes on a long feed, so it is scoped to the playing item.
  var AD_LOOSE_SELECTOR = '[class*="tag" i] span';

  function isAdText(node) {
    if (visibleArea(node) <= 0) return false;
    var text = (node.textContent || '').replace(/\s+/g, '').trim();
    return AD_LABEL_TEXT.test(text);
  }

  function readAdLabel(video) {
    var i;

    // Precise contracts first, document-wide: they match a handful of nodes
    // even on a long feed, and they are the ones that are actually correct.
    var candidates = document.querySelectorAll(AD_CHIP_SELECTOR);
    for (i = 0; i < candidates.length; i += 1) {
      if (isAdText(candidates[i])) return true;
    }

    // The generic guess is scoped to the playing item, because unscoped it is
    // thousands of nodes per call. When there is no item wrapper to scope to,
    // the precise pass above is all we get — deliberately not falling back to a
    // document-wide scan, which would reintroduce the cost this scoping removed.
    var scope = video && video.closest
      ? video.closest('article, li, [data-e2e="feed-item"], [data-e2e="video-item"]')
      : null;
    if (!scope) return false;
    var loose = scope.querySelectorAll(AD_LOOSE_SELECTOR);
    for (i = 0; i < loose.length; i += 1) {
      if (isAdText(loose[i])) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* trigger                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Greet the user once per page load: one line, one matching 打招呼 avatar.
   *
   * The line comes from a local template pool rather than /v1/chat, so it
   * still appears when the local service is down or the token is unset. It is
   * written into the transcript (panel open or not) and shown in the bubble,
   * so opening the panel afterwards shows what was said.
   */
  var openerSaid = false;
  var openerHistory = [];
  var openerDay = '';

  function todayKey() {
    var now = new Date();
    var pad = function (value) { return String(value).padStart(2, '0'); };
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function sayOpener(force) {
    // The greeting is unsolicited speech like any reaction, so `proactive`
    // governs it too. Otherwise turning 主动搭话 off would still let the cat
    // open its mouth on every page load — the exact thing the switch promises
    // to stop. The limiter's own warning is not covered by this: that is
    // enforcement, and it has its own switch (limitEnabled).
    if (!settings.enabled || !settings.proactive) return;
    if (openerSaid && !force) return;
    openerSaid = true;
    openerDay = todayKey();

    var line = Buddy.pickOpener(openerHistory);
    openerHistory = [line].concat(openerHistory).slice(0, Buddy.OPENERS.length - 1);
    try {
      chrome.storage.local.set({ [OPENER_KEY]: openerHistory });
    } catch (_error) { /* extension reloaded */ }

    // greet is the emotion the line itself expresses, so set it explicitly
    // instead of running content detection over a fixed template.
    if (Emotions) ui.setEmotion('greet', { source: 'opener' });
    ui.appendOpening(line);
    ui.showReaction(line);
  }

  /**
   * Say the budget out loud, once per conversation.
   *
   * Two paths can reach this — the user's first message and the first
   * dwell-triggered reaction — and whichever comes first does the announcing.
   * Announcing on both would mean the user hears the same number twice in the
   * first half-minute, which is the opposite of a heads-up.
   *
   * Not gated on `proactive`: this is the limiter explaining a rule that is
   * already in force, the same category as the shutdown line. Turning off
   * unsolicited reactions must not make a closing tab arrive unexplained.
   * It IS gated on `limitEnabled`: with no budget there is nothing to report.
   */
  function announceBudget() {
    if (state.budgetAnnounced) return;
    if (Buddy.limitBudgetMs(settings) <= 0) return;
    state.budgetAnnounced = true;
    var line = Buddy.pickBudgetLine(settings.limitMinutes);
    // Announce says what the rule is; it is not annoyance at the user, so it
    // keeps the resting face rather than borrowing the shutdown's 生气.
    ui.appendNotice(line, EMOTION_DEFAULT, 'budget');
    ui.showReaction(line);
  }

  /** Back off only after a failure, so a slow server cannot mute the next video. */
  function backoff() {
    if (settings.cooldownSeconds > 0) {
      state.cooldownUntil = Date.now() + settings.cooldownSeconds * 1000;
    }
  }

  async function onDwell(video, key, firedBefore) {
    // `firedBefore` counts earlier reactions to this same viewing; anything
    // above zero means this is a second (or later) thought about one video.
    var isRepeat = firedBefore > 0;
    // `proactive` is the user's own switch for unsolicited remarks; it must not
    // disable the ball or the chat panel, so it is checked here rather than in
    // applySettings(). Missing on old config resolves to true, so an upgrade
    // never silences a cat that used to talk.
    if (!settings.enabled || !settings.proactive) return;
    if (!Buddy.modeConfigured(settings)) {
      // 'direct' has no appToken to name, so point at whichever credential this
      // route actually needs instead of always saying 「访问令牌」.
      ui.flash(settings.mode === 'direct' ? '先在插件设置里填 API Key' : '先在插件设置里填访问令牌');
      return;
    }
    // Before the request, so the budget is known even if the model call fails
    // — the number is the user's own setting, not something to wait on.
    announceBudget();
    ui.setState('thinking');

    var screen = readScreenText(video);
    // Report how long this video has actually been on screen: the first wait
    // plus one interval per repeat, so the model knows this is a long watch.
    var watchedMs = Math.round(
      (settings.dwellSeconds + firedBefore * settings.repeatDwellSeconds) * 1000,
    );
    // Sampled frames when readable, whole-tab fallback otherwise. Bounded, so
    // a slow capture never holds up the reaction. Skipped entirely when the
    // user turned screenshots off — `image: null` below then omits `images`
    // from the body, and the prompt already handles a text-only request.
    var capture = settings.captureEnabled
      ? await withTimeout(captureShot(), 4000, { ok: false })
      : { ok: false };
    var payload = Buddy.buildAnalyzeBody({
      fingerprint: Buddy.fnv1a(key),
      dwellMs: watchedMs,
      ocrText: screen.caption,
      caption: screen.caption,
      hashtags: screen.hashtags,
      image: capture && capture.ok ? capture.image : null,
      recentReactions: state.recentReactions,
      adLabel: screen.adLabel,
      repeat: !!isRepeat,
      // Bucket only — the raw duration must never reach the prompt.
      videoDuration: video && video.duration,
    });

    var response = await sendBg({ type: 'sm:analyze', payload: payload });
    ui.setState('idle');

    if (!response.ok) {
      // Only a real failure earns a cooldown; a normal next video must not be
      // silenced just because the previous one was answered.
      backoff();
      ui.flash(response.error && response.error.message ? response.error.message : '暂时没连上');
      return;
    }

    var data = response.data;
    if (!data || data.risk === 'blocked' || !data.reaction) return;

    state.lastAnalysis = {
      summary: data.summary || '',
      keywords: Array.isArray(data.keywords) ? data.keywords : [],
      caption: screen.caption,
    };
    state.recentReactions = [data.reaction].concat(state.recentReactions).slice(0, 2);

    // The video's mood is a cheap, immediate emotion signal. Prefer the
    // concrete reaction text when it contains a recognizable emotion word.
    var vibe = null;
    if (Emotions) {
      if (data.isAd) {
        // An ad is always 生气 regardless of what the text says. The reaction
        // is written to match, but the avatar must not depend on that.
        vibe = Emotions.get('angry');
      } else {
        vibe = Emotions.detect(stripMaoTail(data.reaction)) || Emotions.fromMood(data.mood);
      }
      if (vibe) ui.setEmotion(vibe.id, { source: 'vibe' });
    }

    // Append every video's line to the chat log right away, so the next video
    // still produces a record even when the panel was never opened. A repeat
    // on a long video is not a new video, so it does not bump the counter.
    // The face is passed in because isAd/fromMood reasons that text detection
    // cannot reproduce; the log entry must show the same face as the ball.
    ui.appendReaction(data.reaction, screen.caption, isRepeat, vibe && vibe.id);
    ui.showReaction(data.reaction);
    if (settings.autoOpenPanel) {
      ui.openPanel();
    }
  }

  /**
   * The "喵" tail is a verbal tic, not content. Emotion rules anchor on the
   * end of the sentence (`就这$`), so detecting on the raw text would let a
   * punctuation-only tic change the avatar. Strip it first, then detect.
   */
  function stripMaoTail(text) {
    return String(text == null ? '' : text)
      .replace(/喵+[。，,、！!？?~～\s]*$/, '')
      .trim();
  }

  /* ---------------------------------------------------------------- */
  /* UI                                                                */
  /* ---------------------------------------------------------------- */

  var ui = (function () {
    var els = {};

    var CSS = [
      ':host{all:initial}',
      '*{box-sizing:border-box}',
      '.wrap{position:fixed;z-index:2147483646;right:24px;bottom:96px;--size:60px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',
      '.ball{position:relative;width:var(--size);height:var(--size);border-radius:50%;border:0;padding:0;cursor:grab;background:transparent;display:grid;place-items:center;touch-action:none;user-select:none;}',
      '.ball:active{cursor:grabbing}',
      '.ball:focus-visible{outline:2px solid #b58cff;outline-offset:3px}',
      '.ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#a476ff calc(var(--p,0)*360deg), rgba(255,255,255,.14) 0);transition:opacity .2s;}',
      '.disc{position:relative;width:calc(var(--size) - 6px);height:calc(var(--size) - 6px);border-radius:50%;background:#ffd9e4;display:grid;place-items:center;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.12);}',
      '.disc svg{width:56%;height:56%;display:block}',
      '.emotion-icon{width:100%;height:100%;display:block;object-fit:cover;border-radius:50%;opacity:1;transform:scale(1);transition:opacity .15s ease, transform .18s ease;}',
      '.disc.switching .emotion-icon{opacity:0;transform:scale(.88)}',
      '.thinking .disc{animation:pulse 1s ease-in-out infinite}',
      '@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(.93)}}',
      '.grip{position:absolute;right:-4px;bottom:-4px;width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.28);background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:nwse-resize;opacity:0;pointer-events:none;transition:opacity .15s;touch-action:none;display:grid;place-items:center;z-index:2}',
      '.grip:after{content:"";width:6px;height:6px;border-right:2px solid #7d6a9e;border-bottom:2px solid #7d6a9e;transform:rotate(-45deg) translate(-1px,-1px)}',
      '.wrap:hover .grip,.wrap.resizing .grip{opacity:1;pointer-events:auto}',
      // Touch screens have no hover, so keep the handle visible there.
      '@media (hover:none){.grip{opacity:.85;pointer-events:auto}}',
      '.bubble{position:absolute;right:calc(var(--size) + 10px);bottom:6px;max-width:240px;min-width:120px;padding:10px 12px;border-radius:14px;background:#fff;color:#1b1725;font-size:13px;line-height:1.55;box-shadow:0 10px 30px rgba(0,0,0,.22);cursor:pointer;opacity:0;transform:translateY(6px);pointer-events:none;transition:opacity .18s, transform .18s;word-break:break-word;}',
      '.bubble.on{opacity:1;transform:none;pointer-events:auto}',
      '.bubble:after{content:"";position:absolute;right:-5px;bottom:16px;width:10px;height:10px;background:#fff;transform:rotate(45deg);border-radius:2px;}',
      '.flash{position:absolute;right:calc(var(--size) + 10px);bottom:6px;max-width:220px;padding:7px 10px;border-radius:10px;background:rgba(28,22,44,.92);color:#f2eefb;font-size:12px;line-height:1.5;opacity:0;transition:opacity .2s;pointer-events:none}',
      '.flash.on{opacity:1}',
      '.panel{position:fixed;width:340px;height:430px;border-radius:16px;background:#17131f;color:#efeaf7;box-shadow:0 24px 60px rgba(0,0,0,.45);display:none;flex-direction:column;overflow:hidden;z-index:2147483647;border:1px solid rgba(255,255,255,.08)}',
      '.panel.on{display:flex}',
      '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1f192b;cursor:default}',
      '.avatar{width:26px;height:26px;border-radius:50%;background:#ffd9e4;display:grid;place-items:center;flex:none;overflow:hidden}',
      '.avatar img{width:100%;height:100%;display:block;object-fit:cover}',
      '.avatar svg{width:17px;height:17px}',
      '.title{font-size:13px;font-weight:600;flex:1}',
      '.icon{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:#b7aecb;font-size:15px;line-height:1;cursor:pointer;display:grid;place-items:center}',
      '.icon:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}',
      '.msg{max-width:82%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      // Assistant lines carry a face. The row itself is transparent; the bubble
      // styling moves onto .col so the avatar can sit outside the bubble.
      // The row max-width is wider than .msg on purpose: the avatar takes 36px
      // plus the gap out of the row, and without the extra room the bubble
      // would end up narrower than a user message at the same text length.
      '.msg.a{align-self:flex-start;max-width:96%;padding:0;background:transparent;display:flex;align-items:flex-start;gap:8px}',
      '.msg.a .col{min-width:0;padding:8px 11px;border-radius:12px;border-bottom-left-radius:4px;background:#2a2238}',
      // 36px: at 24px the expression was too small to tell annoyed from angry.
      // Centres the face on the first text line (8px bubble padding + ~18px
      // half-line), so no vertical nudge is needed.
      '.msgava{width:36px;height:36px;flex:none;border-radius:50%;object-fit:cover;background:#ffd9e4;display:block;overflow:hidden}',
      '.msgava.fallback{display:grid;place-items:center}',
      '.msgava.fallback svg{width:24px;height:24px;display:block}',
      '.msg.u{align-self:flex-end;background:#6c4bd8;border-bottom-right-radius:4px}',
      '.msg.sys{align-self:center;background:transparent;color:#9a8fb0;font-size:11px;padding:2px}',
      '.msg.err{align-self:center;background:rgba(255,93,115,.12);color:#ff9baa;font-size:11px}',
      '.msg .meta{margin-top:4px;font-size:10px;line-height:1.4;color:#a99cc0;opacity:.85}',
      // The caret must trail the text inside the bubble, not the whole row: on
      // .msg.a the row is a flex box, so :after on it would land beside the col.
      '.caret:after{content:"";display:inline-block;width:6px;height:13px;margin-left:2px;background:#b79cff;vertical-align:-2px;animation:blink .9s steps(2) infinite}',
      '.msg.a.caret:after{content:none}',
      '.msg.a.caret .col:after{content:"";display:inline-block;width:6px;height:13px;margin-left:2px;background:#b79cff;vertical-align:-2px;animation:blink .9s steps(2) infinite}',
      '@keyframes blink{50%{opacity:0}}',
      '.composer{display:flex;gap:8px;padding:10px;background:#1f192b}',
      '.input{flex:1;min-height:36px;max-height:88px;resize:none;border:0;border-radius:10px;padding:9px 10px;font:inherit;font-size:13px;background:#2a2238;color:#efeaf7;outline:none}',
      '.input::placeholder{color:#8d82a3}',
      '.send{width:60px;border:0;border-radius:10px;background:#6c4bd8;color:#fff;font-size:13px;cursor:pointer}',
      '.send:disabled{opacity:.45;cursor:default}',
      '.empty{padding:20px 8px;color:#8d82a3;font-size:12px;text-align:center;line-height:1.7}',
      '.icon[data-act="history"],.icon[data-act="new"]{width:auto;padding:0 7px;font-size:12px;gap:3px;display:flex;align-items:center}',
      '.history{position:absolute;inset:0;background:#17131f;display:none;flex-direction:column;z-index:3}',
      '.history.on{display:flex}',
      '.hhead{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1f192b;font-size:12px;font-weight:600}',
      '.hhead .grow{flex:1}',
      '.hlist{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin}',
      '.hrow{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:10px;background:#2a2238}',
      '.hrow.cur{outline:1px solid rgba(138,99,255,.5)}',
      '.hrow .label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d9d0ea;font-size:12px}',
      '.hrow button{border:0;border-radius:7px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer;background:#6c4bd8;color:#fff;flex:none}',
      '.hrow button.del{background:rgba(255,93,115,.16);color:#ff9baa}',
      '.hrow button:disabled{opacity:.4;cursor:default}',
      '.hhint{padding:16px 12px;color:#8d82a3;font-size:12px;text-align:center;line-height:1.8}',
      '@media (max-width:520px){.panel{width:calc(100vw - 24px);height:60vh}}',
    ].join('\n');

    var CAT_SVG =
      '<svg viewBox="0 0 64 64" aria-hidden="true">' +
      '<path d="M12 26 L14 8 L28 19 Z" fill="#b58cff"/>' +
      '<path d="M52 26 L50 8 L36 19 Z" fill="#b58cff"/>' +
      '<path d="M32 14c-12 0-21 9-21 21s9 17 21 17 21-5 21-17-9-21-21-21z" fill="#efeaf7"/>' +
      '<circle cx="24" cy="33" r="3.1" fill="#241b38"/>' +
      '<circle cx="40" cy="33" r="3.1" fill="#241b38"/>' +
      '<path d="M30 41h4l-2 3z" fill="#ff7d94"/>' +
      '<path d="M22 44h2M40 44h2M9 32h9M46 32h9" stroke="#241b38" stroke-width="1.6" stroke-linecap="round" opacity=".45" fill="none"/>' +
      '</svg>';

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    /**
     * The panel header's portrait: the default (greet) art, so the panel
     * matches the toolbar icon. Returns null when there is no art to show, in
     * which case the line-drawn cat stays in place.
     */
    function headAvatar() {
      if (!Emotions) return null;
      var img = document.createElement('img');
      img.src = Emotions.iconPath(EMOTION_DEFAULT, 128);
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', function () {
        // Keep the fallback that is already in the header.
        img.remove();
      });
      return img;
    }

    /**
     * The panel lives in the page's DOM, so keyboard/pointer events inside it
     * would otherwise reach Douyin's document-level shortcuts (space pauses,
     * arrows switch videos, wheel scrolls the feed). Stopping propagation at
     * our shadow root keeps those shortcuts out while our own handlers — which
     * run earlier on the target — still work.
     */
    var PAGE_EVENTS = [
      'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
      'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
      'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
      'wheel', 'touchstart', 'touchmove', 'touchend',
      'dragstart', 'selectstart',
    ];

    function shieldFromPage(root, options) {
      for (var i = 0; i < PAGE_EVENTS.length; i += 1) {
        root.addEventListener(PAGE_EVENTS[i], function (event) {
          // Escape is ours to handle once the page no longer sees it.
          if (options && options.onEscape && event.type === 'keydown' && event.key === 'Escape') {
            options.onEscape();
          }
          event.stopPropagation();
        }, false);
      }
    }

    /** True when the page (or an extension reload) detached our shadow hosts. */
    function needsRemount() {
      return !(
        state.host && state.host.isConnected &&
        els.panelHost && els.panelHost.isConnected &&
        els.msgs && els.msgs.isConnected
      );
    }

    function mount() {
      if (!document.body) return;
      var connected = !needsRemount();
      if (connected) {
        applySettings();
        return;
      }
      // Remove stale nodes from an earlier mount before rebuilding.
      var stale = document.querySelectorAll('#sm-buddy-host, #sm-buddy-panel-host');
      for (var i = 0; i < stale.length; i += 1) stale[i].remove();
      state.host = null;
      var host = document.createElement('div');
      host.id = 'sm-buddy-host';
      host.style.all = 'initial';
      var root = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);

      var wrap = el('div', 'wrap');
      var ball = document.createElement('button');
      ball.className = 'ball';
      ball.type = 'button';
      ball.setAttribute('aria-label', '喵喵陪你刷');
      ball.title = '喵喵陪你刷：点开聊天，拖动换位置，右下角小圆点调大小';
      var ring = el('span', 'ring');
      var disc = el('span', 'disc');
      var emotionImg = null;
      if (Emotions) {
        emotionImg = document.createElement('img');
        emotionImg.className = 'emotion-icon';
        emotionImg.alt = (Emotions.get(state.emotion) || Emotions.EMOTIONS[Emotions.DEFAULT]).label;
        emotionImg.draggable = false;
        emotionImg.src = Emotions.iconPath(state.emotion, 128);
        emotionImg.addEventListener('error', function () {
          disc.innerHTML = CAT_SVG;
          state.emotionImg = null;
        });
        disc.appendChild(emotionImg);
      } else {
        disc.innerHTML = CAT_SVG;
      }
      ball.appendChild(ring);
      ball.appendChild(disc);

      // Sits outside the button so it never doubles as a click target.
      var grip = el('span', 'grip');
      grip.setAttribute('role', 'presentation');
      grip.title = '拖动调整悬浮球大小';

      var bubble = el('div', 'bubble');
      bubble.setAttribute('role', 'status');
      var flash = el('div', 'flash');

      wrap.appendChild(bubble);
      wrap.appendChild(flash);
      wrap.appendChild(ball);
      wrap.appendChild(grip);

      var panel = el('div', 'panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '喵喵陪你刷聊天');
      panel.innerHTML =
        '<div class="head">' +
        '<span class="avatar">' + CAT_SVG + '</span>' +
        '<span class="title">喵喵陪你刷</span>' +
        '<button class="icon" data-act="new" title="新建对话">新对话</button>' +
        '<button class="icon" data-act="history" title="历史对话">记录</button>' +
        '<button class="icon" data-act="close" title="关闭">×</button>' +
        '</div>' +
        '<div class="msgs"></div>' +
        '<div class="composer">' +
        '<textarea class="input" rows="1" maxlength="1000" placeholder="说点什么"></textarea>' +
        '<button class="send" type="button">发送</button>' +
        '</div>' +
        '<div class="history">' +
        '<div class="hhead">' +
        '<span class="grow">历史对话</span>' +
        '<button class="icon" data-act="history-close" title="返回">返回</button>' +
        '</div>' +
        '<div class="hlist"></div>' +
        '</div>';

      var panelHost = document.createElement('div');
      panelHost.id = 'sm-buddy-panel-host';
      panelHost.style.all = 'initial';
      var panelRoot = panelHost.attachShadow({ mode: 'open' });
      var panelStyle = document.createElement('style');
      panelStyle.textContent = CSS;
      panelRoot.appendChild(panelStyle);
      panelRoot.appendChild(panel);

      root.appendChild(wrap);
      document.documentElement.appendChild(host);
      document.documentElement.appendChild(panelHost);

      // Swap the line-drawn cat in the header for the real art. Done through
      // the DOM rather than innerHTML because the CSP on Douyin blocks inline
      // handlers, so an onerror attribute would never fire.
      var headerFace = headAvatar();
      if (headerFace) {
        var slot = panel.querySelector('.avatar');
        slot.textContent = '';
        slot.appendChild(headerFace);
      }

      // Both shadow roots sit on the page, so block page shortcuts here.
      shieldFromPage(root);
      shieldFromPage(panelRoot, {
        onEscape: function () {
          if (state.panelOpen) closePanel();
        },
      });

      state.host = host;
      state.root = root;
      state.ball = ball;
      state.ring = ring;
      state.bubble = bubble;
      state.disc = disc;
      state.emotionImg = emotionImg;
      state.grip = grip;
      els.flash = flash;
      els.wrap = wrap;
      els.panel = panel;
      els.panelHost = panelHost;
      els.msgs = panel.querySelector('.msgs');
      els.input = panel.querySelector('.input');
      els.send = panel.querySelector('.send');
      els.history = panel.querySelector('.history');
      els.historyList = panel.querySelector('.hlist');

      bindBall(ball, wrap, bubble);
      bindGrip(grip, ball, wrap);
      bindPanel(panel);
      installKeyboardGuard();
      applySettings();
      paintMessages();
      paintHistory();
      // Re-attaching after a Douyin re-render should not close an open chat.
      if (state.panelOpen && settings.enabled) {
        panel.classList.add('on');
        placePanel();
      }
    }

    function bindBall(ball, wrap, bubble) {
      var pointerId = null;
      var startX = 0;
      var startY = 0;
      var originX = 0;
      var originY = 0;
      var dragging = false;

      ball.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        pointerId = event.pointerId;
        dragging = false;
        var rect = wrap.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        originX = rect.left;
        originY = rect.top;
        try { ball.setPointerCapture(pointerId); } catch (_error) { /* synthetic events */ }
      });

      ball.addEventListener('pointermove', function (event) {
        if (pointerId === null || event.pointerId !== pointerId) return;
        var dx = event.clientX - startX;
        var dy = event.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 4) dragging = true;
        if (!dragging) return;
        applyPosition(originX + dx, originY + dy);
      });

      ball.addEventListener('pointerup', function (event) {
        if (pointerId === null || event.pointerId !== pointerId) return;
        pointerId = null;
        try { ball.releasePointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
        if (dragging) {
          var rect = wrap.getBoundingClientRect();
          savePosition(rect.left, rect.top);
          if (state.panelOpen) placePanel();
          return;
        }
        togglePanel();
      });

      ball.addEventListener('pointercancel', function () {
        pointerId = null;
      });

      ball.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          togglePanel();
        }
      });

      bubble.addEventListener('click', function () {
        hideBubble();
        openPanel();
      });
    }

    // Corner grip: drag to resize the ball. Kept separate from the ball's own
    // drag handler so a resize never turns into a move.
    function bindGrip(grip, ball, wrap) {
      var pointerId = null;
      var startX = 0;
      var startY = 0;
      var startSize = 0;

      grip.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startSize = Math.round(ball.getBoundingClientRect().width) || settings.ballSize;
        wrap.classList.add('resizing');
        try { grip.setPointerCapture(pointerId); } catch (_error) { /* ignore */ }
      });

      grip.addEventListener('pointermove', function (event) {
        if (pointerId === null || event.pointerId !== pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        // Follow the larger axis so the ball grows the way the pointer moves.
        var delta = Math.max(event.clientX - startX, event.clientY - startY);
        previewSize(startSize + Math.round(delta));
      });

      grip.addEventListener('pointerup', function (event) {
        if (pointerId === null || event.pointerId !== pointerId) return;
        pointerId = null;
        wrap.classList.remove('resizing');
        try { grip.releasePointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
        commitSize();
      });

      grip.addEventListener('pointercancel', function () {
        if (pointerId === null) return;
        pointerId = null;
        wrap.classList.remove('resizing');
        commitSize();
      });
    }

    /**
     * The document_start guard owns keyboard isolation. It runs before page
     * capture listeners; these handlers keep Enter/Escape working even though
     * the guard stops the event before it reaches the shadow root.
     */
    function installKeyboardGuard() {
      var guard = window.__smKeyboardGuard;
      if (!guard || typeof guard.setHandlers !== 'function') return;
      guard.setHandlers({
        enter: function () { sendMessage(); },
        escape: function () { if (state.panelOpen) closePanel(); },
      });
    }

    function bindPanel(panel) {
      panel.querySelector('[data-act="close"]').addEventListener('click', function () {
        closePanel();
      });
      panel.querySelector('[data-act="new"]').addEventListener('click', function () {
        newSession();
      });
      panel.querySelector('[data-act="history"]').addEventListener('click', function () {
        openHistory();
      });
      panel.querySelector('[data-act="history-close"]').addEventListener('click', function () {
        closeHistory();
      });
      els.send.addEventListener('click', sendMessage);
      els.input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          sendMessage();
        }
      });
      els.input.addEventListener('input', autosize);
    }

    function autosize() {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(88, els.input.scrollHeight) + 'px';
    }

    /**
     * Hide our own overlay for the instant a whole-tab screenshot is taken.
     *
     * `captureVisibleTab` photographs the composited page, so without this the
     * ball (one of 9 faces) and the still-visible previous bubble end up in the
     * image — the model then reads its own last reply off the screen and
     * echoes it. The frame path avoids the problem entirely; this covers the
     * fallback.
     */
    function setCaptureHidden(hidden) {
      // `display` is owned by applySettings(); only visibility is ours to touch.
      if (state.host) state.host.style.visibility = hidden ? 'hidden' : '';
      if (els.panelHost) els.panelHost.style.visibility = hidden ? 'hidden' : '';
    }

    function applySettings() {
      if (!state.host) return;
      var on = settings.enabled;
      state.host.style.display = on ? '' : 'none';
      els.panelHost.style.display = on ? '' : 'none';
      if (!on) closePanel();
      // Turning the plugin back on within the same day greets again, the same
      // as a fresh page load would.
      if (on && state.wasDisabled) sayOpener(true);
      state.wasDisabled = !on;
      els.wrap.style.setProperty('--size', settings.ballSize + 'px');
      if (!position) {
        els.wrap.style.right = '24px';
        els.wrap.style.bottom = '96px';
        els.wrap.style.left = 'auto';
        els.wrap.style.top = 'auto';
      } else {
        applyPosition(position.x, position.y);
      }
      tracker.settingsChanged();
    }

    function applyPosition(left, top, size) {
      var diameter = size || settings.ballSize;
      var maxLeft = Math.max(8, window.innerWidth - diameter - 8);
      var maxTop = Math.max(8, window.innerHeight - diameter - 8);
      var x = Math.min(maxLeft, Math.max(8, left));
      var y = Math.min(maxTop, Math.max(8, top));
      els.wrap.style.left = x + 'px';
      els.wrap.style.top = y + 'px';
      els.wrap.style.right = 'auto';
      els.wrap.style.bottom = 'auto';
      if (state.panelOpen) placePanel();
    }

    // Live size while the grip is dragged; only persisted on release.
    function previewSize(size) {
      if (!els.wrap) return 0;
      var clamped = Math.min(Buddy.BALL_SIZE_MAX, Math.max(Buddy.BALL_SIZE_MIN, Math.round(size)));
      els.wrap.style.setProperty('--size', clamped + 'px');
      if (position) applyPosition(position.x, position.y, clamped);
      if (state.panelOpen) placePanel();
      return clamped;
    }

    function commitSize() {
      if (!els.wrap) return;
      var size = Math.round(parseFloat(els.wrap.style.getPropertyValue('--size')) || settings.ballSize);
      var clamped = Math.min(Buddy.BALL_SIZE_MAX, Math.max(Buddy.BALL_SIZE_MIN, size));
      if (clamped === settings.ballSize) return;
      try {
        chrome.storage.local.get('settings', function (data) {
          var next = Buddy.normalizeSettings(
            Object.assign({}, data && data.settings ? data.settings : settings, { ballSize: clamped }),
          );
          chrome.storage.local.set({ settings: next });
        });
      } catch (_error) { /* ignore */ }
    }

    function setProgress(value) {
      if (!state.ring) return;
      var current = Number(state.ring.style.getPropertyValue('--p')) || 0;
      if (Math.abs(current - value) < 0.02 && value !== 0 && value !== 1) return;
      state.ring.style.setProperty('--p', String(value));
      state.ring.style.opacity = value > 0.02 ? '1' : '0';
    }

    function setState(mode) {
      if (!state.ball) return;
      state.ball.classList.toggle('thinking', mode === 'thinking');
    }

    function ensureEmotionImage() {
      if (!Emotions || !state.disc) return null;
      if (state.emotionImg && state.emotionImg.isConnected) return state.emotionImg;
      state.disc.textContent = '';
      var img = document.createElement('img');
      img.className = 'emotion-icon';
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', function () {
        if (!state.disc) return;
        state.disc.innerHTML = CAT_SVG;
        state.emotionImg = null;
      });
      state.disc.appendChild(img);
      state.emotionImg = img;
      return img;
    }

    function setEmotion(value, options) {
      if (!Emotions) return false;
      var emotion = Emotions.get(value);
      if (!emotion) return false;
      options = options || {};
      var now = Date.now();
      var same = state.emotion === emotion.id;
      if (!options.force && !same && now - state.emotionLastAt < 600) return false;

      state.emotionLastAt = now;
      state.emotion = emotion.id;
      // Only assistant-driven switches count towards the quota: re-arming the
      // hold timer, resets to greet and video reactions are not conversation
      // turns and would otherwise drown out the real distribution.
      if (options.source === 'assistant') tallyEmotion(emotion.id);
      var img = ensureEmotionImage();
      if (!img) return false;

      if (state.ball) {
        state.ball.setAttribute('aria-label', '喵喵陪你刷 · ' + emotion.label);
        state.ball.title = '喵喵陪你刷 · ' + emotion.label + '：点开聊天，拖动换位置，右下角小圆点调大小';
      }

      window.clearTimeout(state.emotionSwapTimer);
      if (!same || !img.getAttribute('src')) {
        state.disc.classList.add('switching');
        state.emotionSwapTimer = window.setTimeout(function () {
          if (!state.emotionImg || !state.disc) return;
          state.emotionImg.src = Emotions.iconPath(emotion.id, 128);
          state.emotionImg.alt = emotion.label;
          state.disc.classList.remove('switching');
        }, 110);
      }

      // Duration is user-controlled (popup: 图标保持秒数). 0 = 一直保持到下次变化。
      window.clearTimeout(state.emotionTimer);
      var holdMs = Buddy.emotionHoldMs(settings, options.holdMs);
      if (holdMs > 0) armEmotionReset(holdMs);
      return true;
    }

    /**
     * Reset to the default mood after `holdMs`. While the chat is open the mood
     * is left alone, so the timer re-arms instead of dropping the icon mid
     * conversation; closing the panel lets the next expiry land normally.
     */
    function armEmotionReset(holdMs) {
      window.clearTimeout(state.emotionTimer);
      state.emotionTimer = window.setTimeout(function () {
        if (state.panelOpen) {
          armEmotionReset(holdMs);
          return;
        }
        setEmotion(EMOTION_DEFAULT, { force: true, holdMs: 0, source: 'reset' });
      }, holdMs);
    }

    function flash(text) {
      if (!els.flash) return;
      els.flash.textContent = text;
      els.flash.classList.add('on');
      window.clearTimeout(els.flash._timer);
      els.flash._timer = window.setTimeout(function () {
        els.flash.classList.remove('on');
      }, 3200);
    }

    function showReaction(text) {
      if (!state.bubble) return;
      state.bubble.textContent = text;
      state.bubble.classList.add('on');
      // The badge is deliberately not shown here. A reaction is already
      // announced by the bubble itself, and a red dot on the avatar every time
      // a video triggers was more noise than signal.
      window.clearTimeout(state.bubbleTimer);
      state.bubbleTimer = window.setTimeout(hideBubble, Buddy.bubbleMs(settings));
    }

    function hideBubble() {
      if (state.bubble) state.bubble.classList.remove('on');
    }

    function placePanel() {
      var panel = els.panel;
      var width = panel.offsetWidth || 340;
      var height = panel.offsetHeight || 430;
      var ballRect = els.wrap.getBoundingClientRect();
      var margin = 12;
      var left = ballRect.left + ballRect.width / 2 - width / 2;
      var top = ballRect.top - height - margin;
      if (top < margin) top = Math.min(window.innerHeight - height - margin, ballRect.bottom + margin);
      left = Math.min(window.innerWidth - width - margin, Math.max(margin, left));
      top = Math.min(window.innerHeight - height - margin, Math.max(margin, top));
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function openPanel() {
      if (!els.panel || !settings.enabled) return;
      closePanel();
      closeHistory();
      els.panel.classList.add('on');
      placePanel();
      state.panelOpen = true;
      hideBubble();
      // Rebuild from state: proactive lines may have arrived while the panel
      // was closed, or the page may have wiped our nodes.
      paintMessages();
      if (state.messages.length === 0) {
        pushMessage('assistant', '悬浮球在这儿，刷到想吐槽的就说喵', { seed: true, emotion: 'greet' });
      }
      els.input.focus();
      els.msgs.scrollTop = els.msgs.scrollHeight;
    }

    function closePanel() {
      if (!els.panel) return;
      els.panel.classList.remove('on');
      closeHistory();
      state.panelOpen = false;
      stopStreaming();
      // The mood reset is owned by the hold timer (popup: 图标保持秒数), not by
      // closing the panel. Forcing greet here would cut a user-configured hold
      // short every time the chat is dismissed.
    }

    function togglePanel() {
      if (state.panelOpen) closePanel();
      else openPanel();
    }

    /* -------- messages -------- */

    /**
     * How many nudge lines stay in the transcript.
     *
     * Small on purpose: at one line per five seconds this is the last ~1.5
     * minutes of nagging, which is enough to see that it happened. Keeping
     * hundreds would bury the conversation and bloat every save.
     */
    var MAX_SCRIPTED_MESSAGES = 20;

    /**
     * Add a message to the log. The state array is the single source of truth:
     * the DOM is only a projection of it, so a page re-render or a remount can
     * never lose a line. Returns the message object, whose `node` may be null
     * while the panel is not mounted.
     */
    function pushMessage(role, content, options) {
      options = options || {};
      var message = {
        role: role,
        content: content,
        meta: options.meta || '',
        at: Date.now(),
        // Which face leads this assistant line. Only settled replies have one;
        // a streaming reply starts blank and gets its face in finishStream().
        emotion: options.emotion || '',
        // Greeting placeholders are UI, not conversation: keep them out of
        // history so an untouched session never shows up in the list.
        seed: !!options.seed,
        // Local chatter that the model neither said nor needs to see. Streamed
        // into the same array as real turns on purpose — it has to be visible
        // in the transcript and has to survive a panel remount — but it is
        // excluded from the request history and from the message cap below.
        scripted: options.scripted || '',
        node: null,
      };
      state.messages.push(message);
      trimMessages();
      if (els.msgs && !options.silent) {
        var hint = els.msgs.querySelector('.empty');
        if (hint) hint.remove();
        message.node = renderMessage(message);
        scrollToBottom();
      }
      scheduleSave();
      return message;
    }

    /**
     * Keep the transcript bounded, but count the two kinds of line separately.
     *
     * The nudge speaks every five seconds until answered, so a user who leaves
     * the tab alone for twenty minutes produces ~240 lines. Under one shared
     * cap they would push real conversation out of the 300-message window long
     * before that gets full — the user comes back to find their actual chat
     * gone and forty "理我一下" in its place. So scripted chatter is held to its
     * own much smaller budget, OLDEST FIRST, and the conversation cap never
     * counts it. Real turns are therefore never evicted by nagging.
     */
    function trimMessages() {
      var scripted = 0;
      for (var i = state.messages.length - 1; i >= 0; i -= 1) {
        if (!state.messages[i].scripted) continue;
        scripted += 1;
        if (scripted <= MAX_SCRIPTED_MESSAGES) continue;
        var stale = state.messages[i];
        state.messages.splice(i, 1);
        if (stale.node && stale.node.isConnected) stale.node.remove();
      }
      var real = state.messages.filter(function (message) { return !message.scripted; }).length;
      for (var j = 0; j < state.messages.length && real > Buddy.MAX_SESSION_MESSAGES; j += 1) {
        if (state.messages[j].scripted) continue;
        var dropped = state.messages.splice(j, 1)[0];
        j -= 1;
        real -= 1;
        if (dropped.node && dropped.node.isConnected) dropped.node.remove();
      }
    }

    var ROLE_CLASS = { assistant: 'a', user: 'u', sys: 'sys', err: 'err' };

    /** The face that leads one assistant line; a placeholder if art is missing. */
    function renderAvatar(emotionId) {
      var span = el('span', 'msgava');
      var known = Emotions && Emotions.get(emotionId);
      if (!known) {
        // No emotion yet (still streaming, or a restored line from before this
        // feature): a small mark keeps the column aligned without pretending
        // to an expression the model has not produced.
        span.className += ' fallback';
        span.innerHTML = CAT_SVG;
        return span;
      }
      var img = document.createElement('img');
      img.className = 'msgava';
      img.src = Emotions.iconPath(known.id, 128);
      img.alt = known.label;
      img.draggable = false;
      img.addEventListener('error', function () {
        img.replaceWith(renderAvatar(''));
      });
      return img;
    }

    function renderMessage(message) {
      if (!els.msgs) return null;
      var role = ROLE_CLASS[message.role] || 'sys';
      var node = el('div', 'msg ' + role);
      var body = el('span', 'body', message.content);
      if (role === 'a') {
        // Assistant lines get a face outside the bubble, so the avatar column
        // stays fixed whatever the line length.
        var face = message.emotion;
        if (!face && Emotions && message.content) {
          // Lines saved before faces were recorded still get one, derived from
          // the text. Deterministic, so re-painting the panel is stable.
          var guess = Emotions.detect(stripMaoTail(message.content));
          if (guess) face = guess.id;
        }
        node.appendChild(renderAvatar(face));
        var col = el('div', 'col');
        col.appendChild(body);
        if (message.meta) col.appendChild(el('div', 'meta', message.meta));
        node.appendChild(col);
      } else {
        node.appendChild(body);
        if (message.meta) node.appendChild(el('div', 'meta', message.meta));
      }
      // Remember the body node so streaming can update text without wiping meta.
      message.body = body;
      message.node = node;
      els.msgs.appendChild(node);
      return node;
    }

    /**
     * Swap the face of an already-rendered assistant line. Used when a reply
     * finishes: the bubble was created empty, so its avatar is filled in once
     * the text says what the mood is.
     */
    function setMessageEmotion(message, emotionId) {
      if (!message) return;
      message.emotion = emotionId || '';
      if (!message.node || !message.node.isConnected) return;
      var old = message.node.querySelector('.msgava');
      if (!old) return;
      var next = renderAvatar(message.emotion);
      if (next.className.indexOf('fallback') >= 0 && old.className.indexOf('fallback') >= 0) return;
      old.replaceWith(next);
    }

    function paintMessages() {
      if (!els.msgs) return;
      els.msgs.textContent = '';
      state.messages.forEach(function (message) {
        message.node = renderMessage(message);
      });
      if (state.messages.length === 0) {
        els.msgs.appendChild(el('div', 'empty', '刷满 ' + settings.dwellSeconds + ' 秒，我会主动开口\n也可以直接问我'));
      }
      if (state.panelOpen) scrollToBottom();
    }

    function scrollToBottom() {
      if (els.msgs) els.msgs.scrollTop = els.msgs.scrollHeight;
    }

    /**
     * Count one assistant-driven emotion for this conversation and report the
     * running tally with the next chat request. The server holds no state; it
     * uses the tally only on turns where the user's words imply no emotion.
     */
    function tallyEmotion(id) {
      if (!state.emotionTally) state.emotionTally = {};
      state.emotionTally[id] = (state.emotionTally[id] || 0) + 1;
    }

    function appendSystem(text, kind) {
      // System notes are diagnosis, not conversation: keep them out of the
      // transcript that gets restored from history.
      if (!els.msgs) return;
      els.msgs.appendChild(el('div', 'msg ' + (kind || 'sys'), text));
      scrollToBottom();
    }

    /**
     * The page-load greeting. Marked `seed` like the panel placeholder: it is
     * part of the visible transcript but not of the saved conversation, so
     * merely opening Douyin never creates a history entry with one line in it.
     */
    function appendOpening(text) {
      var line = Buddy.cleanText(text, 200);
      if (!line) return;
      // The opener is always 打招呼, matching the ball set by sayOpener().
      pushMessage('assistant', line, { seed: true, emotion: 'greet' });
    }

    /**
     * A line that is not tied to a video: the watch-time shutdown, the budget
     * reminder and the silence nudge. It is a real utterance, so unlike the
     * opener it is *not* `seed` — if the tab survives long enough to archive,
     * the record shows why it closed.
     *
     * `scripted` marks lines this extension wrote itself. They stay in the
     * transcript and in the archive, but `startStream()` leaves them out of the
     * history sent to the model: feeding it forty "理我一下会少块肉吗喵" would
     * teach it to answer in nags, and would spend the 12-turn window on them
     * instead of on the conversation.
     */
    function appendNotice(text, emotionId, scripted) {
      var line = Buddy.cleanText(text, 200);
      if (!line) return;
      pushMessage('assistant', line, { emotion: emotionId || '', scripted: scripted || '' });
    }

    /**
     * Every video that triggers a reaction gets its own log entry, whether or
     * not the panel is open. Two videos with the same (or empty) caption still
     * produce two entries; the ordinal keeps them distinguishable.
     *
     * `isRepeat` marks a second thought about the *same* long video: it is a
     * continuation, so it must not consume the next video number.
     */
    function appendReaction(reaction, caption, isRepeat, emotionId) {
      var text = Buddy.cleanText(reaction, 200);
      if (!text) return;
      if (!isRepeat) state.videoCount += 1;
      var source = Buddy.cleanText(caption, 60);
      var label = isRepeat ? '视频 ' + state.videoCount + ' · 接着说' : '视频 ' + state.videoCount;
      var meta = source ? label + ' · ' + source : label;
      pushMessage('assistant', text, { meta: meta, emotion: emotionId || '' });
    }

    /* -------- session history -------- */

    function currentSession() {
      var kept = state.messages.filter(function (message) {
        if (message.seed) return false;
        if (message.role !== 'user' && message.role !== 'assistant') return false;
        return Buddy.cleanText(message.content, 1).length > 0;
      });
      if (kept.length === 0) return null;
      return {
        id: state.sessionId,
        startedAt: state.sessionStartedAt,
        endedAt: Date.now(),
        emotionTally: state.emotionTally,
        messages: kept.map(function (message) {
          return {
            role: message.role,
            content: message.content,
            meta: message.meta || '',
            // Persisted so a restored conversation keeps each line's face
            // instead of re-deriving it from text that may not match.
            emotion: message.emotion || '',
            // Local scripted lines must stay out of the model history after a
            // restore, so the marker travels with the saved message.
            scripted: message.scripted || '',
            at: message.at || 0,
          };
        }),
      };
    }

    /**
     * Persist the current conversation so closing the tab does not lose it.
     * `force` also saves a session that has not changed since the last write,
     * which is what pagehide/visibilitychange use.
     */
    function persistSession(force) {
      if (!state.historyReady) return;
      if (!force && !state.sessionDirty) return;
      var session = currentSession();
      if (!session) return;
      state.history = Buddy.addSessionToHistory(state.history, session);
      state.sessionDirty = false;
      writeHistory();
    }

    function scheduleSave() {
      if (!state.historyReady) return;
      state.sessionDirty = true;
      window.clearTimeout(state.saveTimer);
      state.saveTimer = window.setTimeout(function () {
        persistSession(false);
      }, 1200);
    }

    function writeHistory() {
      try {
        chrome.storage.local.set({ [Buddy.HISTORY_KEY]: state.history });
      } catch (_error) { /* extension reloaded */ }
    }

    /** Swap the visible log for a stored conversation (read-only view). */
    function loadSession(id) {
      var session = null;
      for (var i = 0; i < state.history.length; i += 1) {
        if (state.history[i].id === id) { session = state.history[i]; break; }
      }
      if (!session) return false;
      persistSession();
      state.messages = session.messages.map(function (message) {
        return {
          role: message.role,
          content: message.content,
          meta: message.meta || '',
          emotion: message.emotion || '',
          scripted: message.scripted || '',
          at: message.at || 0,
          node: null,
        };
      });
      // Keep the same session id: continuing a restored conversation updates
      // that history entry instead of duplicating the transcript.
      state.sessionId = session.id;
      state.sessionStartedAt = session.startedAt;
      state.sessionDirty = false;
      state.videoCount = 0;
      // Resuming an old conversation keeps its palette, so the quota does not
      // restart from zero and start repeating faces it already overused.
      state.emotionTally = Buddy.normalizeEmotionTally(session.emotionTally);
      closeHistory();
      paintMessages();
      if (state.panelOpen) scrollToBottom();
      return true;
    }

    /**
     * Start a fresh conversation. The current one is archived first, so
     * "new chat" never costs the user the transcript they were reading.
     * The video anchor (state.lastAnalysis) is intentionally kept: a new
     * conversation is still about the clip on screen.
     */
    function newSession() {
      // A half-finished reply belongs to the old conversation and would be
      // archived as a truncated sentence; drop it before saving.
      var wasStreaming = state.streaming;
      stopStreaming();
      if (wasStreaming) {
        var last = state.messages[state.messages.length - 1];
        if (last && last.role === 'assistant') dropMessage(last);
      }
      persistSession(true);

      state.sessionId = Buddy.uuid();
      state.sessionStartedAt = Date.now();
      state.sessionDirty = false;
      state.videoCount = 0;
      state.messages = [];
      // A fresh conversation starts from a clean palette.
      state.emotionTally = Object.create(null);
      // The budget notice is once per conversation, so a new conversation earns
      // a new one. The silence clock restarts too: the panel was just used.
      state.budgetAnnounced = false;
      nudge.restart();

      closeHistory();
      paintMessages();
      if (state.panelOpen && state.messages.length === 0) {
        pushMessage('assistant', '新开一页，想聊什么喵', { seed: true, emotion: 'greet' });
        els.input.focus();
      }
      paintHistory();
    }

    function openHistory() {
      if (!els.history) return;
      // Make sure the open conversation is included before listing.
      persistSession();
      state.historyOpen = true;
      els.history.classList.add('on');
      paintHistory();
    }

    function closeHistory() {
      if (!els.history) return;
      state.historyOpen = false;
      els.history.classList.remove('on');
    }

    function paintHistory() {
      if (!els.historyList) return;
      els.historyList.textContent = '';
      // The open conversation is listed too (marked and not re-openable), so
      // the list reads as the full set of conversations you can switch between.
      var sessions = state.history;
      if (sessions.length === 0) {
        els.historyList.appendChild(
          el('div', 'hhint', '还没有历史对话。\n聊几句就会自动存进来。'),
        );
        return;
      }
      sessions.forEach(function (session) {
        var current = session.id === state.sessionId;
        var row = el('div', 'hrow' + (current ? ' cur' : ''));
        row.appendChild(el('span', 'label', Buddy.describeSession(session)));
        var open = el('button', '', current ? '当前' : '查看');
        open.type = 'button';
        open.disabled = current;
        open.addEventListener('click', function () {
          loadSession(session.id);
        });
        var remove = el('button', 'del', '删除');
        remove.type = 'button';
        // Deleting the open conversation would only drop its archive: the live
        // messages stay and would be written straight back on the next save.
        // Start a new conversation first if that is what you meant.
        remove.disabled = current;
        remove.addEventListener('click', function () {
          state.history = Buddy.removeSessionFromHistory(state.history, session.id);
          writeHistory();
          paintHistory();
        });
        row.appendChild(open);
        row.appendChild(remove);
        els.historyList.appendChild(row);
      });
    }

    /* -------- chat -------- */

    function stopStreaming() {
      if (state.port) {
        try { state.port.disconnect(); } catch (_error) { /* ignore */ }
        state.port = null;
      }
      state.streaming = false;
      if (els.send) els.send.disabled = false;
    }

    function sendMessage() {
      var text = Buddy.cleanText(els.input ? els.input.value : '', 1000);
      if (!text || state.streaming) return;

      // The one place the user counts as having spoken. Reset the silence
      // clock before anything else can throw, so a failed request still ends
      // the nagging — they did their part by answering.
      nudge.resolve();

      pushMessage('user', text);
      els.input.value = '';
      autosize();
      // First thing the user says this conversation: tell them the budget
      // before the reply, so the number is not buried after the model's line.
      announceBudget();
      startStream(text);
    }

    function startStream(text) {
      var history = state.messages
        .slice(0, -1)
        // Our own scripted lines are not part of the conversation the model is
        // continuing. Video reactions DO belong here (that is the whole point
        // of the anchor), which is why this filters on `scripted` and not on
        // "assistant but not streamed".
        .filter(function (message) { return !message.scripted; })
        .filter(function (message) { return message.role === 'user' || message.role === 'assistant'; })
        .map(function (message) { return { role: message.role, content: message.content }; });

      var payload = Buddy.buildChatBody({
        sessionId: state.sessionId,
        message: text,
        context: state.lastAnalysis || {},
        history: history,
        emotionTally: state.emotionTally,
      });

      // Start the bubble with the face the ball is showing right now, so the
      // row never appears with an empty avatar; finishStream() replaces it
      // once the reply's own mood is known.
      var reply = pushMessage('assistant', '', { emotion: state.emotion });
      if (reply.node) reply.node.classList.add('caret');

      state.streaming = true;
      els.send.disabled = true;

      var port;
      try {
        port = chrome.runtime.connect({ name: 'sm-net' });
      } catch (_error) {
        dropMessage(reply);
        appendSystem('插件已更新，刷新页面后再试', 'err');
        stopStreaming();
        return;
      }
      state.port = port;

      port.onMessage.addListener(function (message) {
        if (!message) return;
        if (message.type === 'delta') {
          reply.content += message.text;
          // The page may have wiped our DOM mid-stream; re-render if so.
          if (!reply.node || !reply.node.isConnected) {
            reply.node = renderMessage(reply);
          }
          if (reply.body) reply.body.textContent = reply.content;
          if (state.streaming && reply.node) reply.node.classList.add('caret');
          scrollToBottom();
          scheduleSave();
        } else if (message.type === 'error') {
          var info = message.error || {};
          if (!reply.content) dropMessage(reply);
          appendSystem((info.message || '模型暂时不可用') + '（' + (info.code || 'ERROR') + '）', 'err');
        } else if (message.type === 'done') {
          finishStream(reply, message.emotion);
        }
      });

      port.onDisconnect.addListener(function () {
        if (state.streaming) finishStream(reply);
      });

      port.postMessage({ type: 'chat', payload: payload });
    }

    function dropMessage(message) {
      var index = state.messages.indexOf(message);
      if (index >= 0) state.messages.splice(index, 1);
      if (message.node && message.node.isConnected) message.node.remove();
    }

    function finishStream(reply, serverEmotion) {
      stopStreaming();
      if (reply.node && reply.node.isConnected) reply.node.classList.remove('caret');
      if (!reply.content.trim()) {
        dropMessage(reply);
        appendSystem('它没憋出话，再问一次', 'err');
        return;
      }
      // Only the assistant's completed reply drives the avatar, so the icon
      // reflects the model rather than the user's prompt.
      if (Emotions) {
        var replyVibe = Emotions.detect(stripMaoTail(reply.content));
        if (!replyVibe && serverEmotion) replyVibe = Emotions.get(serverEmotion);
        if (replyVibe) {
          ui.setEmotion(replyVibe.id, { force: true, source: 'assistant' });
          // Same face as the ball, so the line and the avatar tell one story.
          setMessageEmotion(reply, replyVibe.id);
        }
      }
      persistSession();
    }

    return {
      mount: mount,
      needsRemount: needsRemount,
      applySettings: applySettings,
      setCaptureHidden: setCaptureHidden,
      setProgress: setProgress,
      setState: setState,
      setEmotion: setEmotion,
      previewSize: previewSize,
      commitSize: commitSize,
      appendReaction: appendReaction,
      appendOpening: appendOpening,
      appendNotice: appendNotice,
      showReaction: showReaction,
      flash: flash,
      openPanel: openPanel,
      closePanel: closePanel,
      openHistory: openHistory,
      paintHistory: paintHistory,
      persistSession: persistSession,
      empty: function () { return state.messages.length === 0; },
    };
  })();

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  // Preload the 9 avatars so the first mood switch is instant.
  if (Emotions && typeof Emotions.preload === 'function') {
    Emotions.preload().forEach(function (src) {
      var image = new Image();
      image.src = src;
    });
  }

  var mountTimer = window.setInterval(function () {
    if (document.body) {
      window.clearInterval(mountTimer);
      loadStored();
      tracker.start();
    }
  }, 200);

  // A page can be closed or reloaded at any moment. Persist the conversation on
  // every exit path that gives us a chance to run, so "closed the tab" equals
  // "saved to history" even if no chat turn finished in the last second.
  window.addEventListener('pagehide', function () {
    ui.persistSession();
    limiter.flush();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      ui.persistSession();
      limiter.flush();
      // Talking to a tab nobody is looking at is noise, and a background tab
      // gets its timers throttled anyway; the silence clock keeps running, so
      // `tick()` restarts the nudge on the next visit if it is still due.
      nudge.stop();
    }
  });

  // Douyin is a single-page app, so coming back the next day usually means
  // switching tabs rather than reloading. Greet again in that case; switching
  // back and forth within one day stays quiet.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !openerSaid) return;
    if (todayKey() !== openerDay) sayOpener(true);
  });

  // Escape typed inside the panel is handled by its shadow-root shield; this
  // catches Escape pressed while the page (not our UI) has focus.
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.panelOpen) ui.closePanel();
  });


  // Keep the panel inside the viewport on resize.
  window.addEventListener('resize', function () {
    if (position) ui.applySettings();
  });
})();
