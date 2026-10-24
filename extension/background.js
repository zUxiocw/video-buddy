/* Service worker: the only place that talks to the local buddy server.
 * Content scripts cannot call 127.0.0.1 directly (CORS), so every request
 * goes through here. Also handles screenshot capture + JPEG compression.
 */
importScripts('shared/core.js');

var Buddy = self.Buddy;
var DEFAULT_ICON_PATH = 'icons/icon48.png';

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get('settings', function (data) {
    if (!data || !data.settings) {
      chrome.storage.local.set({ settings: Buddy.normalizeSettings({}) });
    }
  });
});

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('settings', function (data) {
      resolve(Buddy.normalizeSettings(data && data.settings));
    });
  });
}

function headersFor(settings) {
  return {
    authorization: 'Bearer ' + settings.appToken,
    'x-device-id': settings.deviceId,
    'content-type': 'application/json',
  };
}

async function readError(response) {
  var fallback = '服务返回 HTTP ' + response.status;
  try {
    var body = await response.json();
    if (body && body.error && typeof body.error.message === 'string') {
      return { code: body.error.code || 'ERROR', message: body.error.message, retryable: !!body.error.retryable, status: response.status };
    }
  } catch (_error) {
    /* non-JSON error page */
  }
  return { code: 'ERROR', message: fallback, retryable: response.status >= 500, status: response.status };
}

async function ping() {
  var settings = await getSettings();
  var startedAt = Date.now();
  try {
    var response = await fetch(settings.serverUrl + '/health', { cache: 'no-store' });
    if (!response.ok) {
      return { ok: false, error: await readError(response) };
    }
    var body = await response.json();
    return {
      ok: true,
      provider: body.provider,
      configuredProvider: body.configuredProvider,
      providerFallback: !!body.providerFallback,
      models: body.model,
      version: body.version,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, error: { code: 'NETWORK', message: '连不上本地服务，先确认它已启动', retryable: true } };
  }
}

async function analyze(payload) {
  var settings = await getSettings();
  if (!settings.appToken) {
    return { ok: false, error: { code: 'NO_TOKEN', message: '还没填访问令牌，去插件设置里填一下', retryable: false } };
  }
  try {
    var response = await fetch(settings.serverUrl + '/v1/analyze', {
      method: 'POST',
      headers: headersFor(settings),
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    if (!response.ok) return { ok: false, error: await readError(response) };
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, error: { code: 'NETWORK', message: '连不上本地服务', retryable: true } };
  }
}

/* ---------- screenshot ---------- */

function captureVisible() {
  return new Promise(function (resolve, reject) {
    chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 82 }, function (dataUrl) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!dataUrl) {
        reject(new Error('empty capture'));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function dataUrlToBase64(dataUrl) {
  var index = dataUrl.indexOf(',');
  return index >= 0 ? dataUrl.slice(index + 1) : '';
}

/** Downscale to <= 960px wide and shrink quality until it fits 400KiB. */
async function compressScreenshot(dataUrl) {
  var raw = dataUrlToBase64(dataUrl);
  try {
    var blob = await (await fetch(dataUrl)).blob();
    var bitmap = await createImageBitmap(blob);
    var maxWidth = 960;
    var scale = Math.min(1, maxWidth / bitmap.width);
    var width = Math.max(1, Math.round(bitmap.width * scale));
    var height = Math.max(1, Math.round(bitmap.height * scale));

    var canvas = new OffscreenCanvas(width, height);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    var qualities = [0.72, 0.6, 0.48];
    for (var i = 0; i < qualities.length; i += 1) {
      var output = await canvas.convertToBlob({ type: 'image/jpeg', quality: qualities[i] });
      if (output.size <= 380 * 1024) {
        var buffer = await output.arrayBuffer();
        return { data: arrayBufferToBase64(buffer), bytes: output.size };
      }
    }
    return null;
  } catch (error) {
    // Canvas unavailable or decode failed: fall back to the raw capture when small.
    if (raw.length * 0.75 <= 400 * 1024) return { data: raw, bytes: Math.round(raw.length * 0.75) };
    return null;
  }
}

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunk = 0x8000;
  var binary = '';
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function captureForAnalyze() {
  try {
    var dataUrl = await captureVisible();
    var compressed = await compressScreenshot(dataUrl);
    return compressed ? { ok: true, image: compressed } : { ok: false, error: 'capture too large' };
  } catch (error) {
    return { ok: false, error: 'capture unavailable' };
  }
}

/* ---------- chat SSE ---------- */

function streamChat(port, payload) {
  var controller = new AbortController();
  var closed = false;

  port.onDisconnect.addListener(function () {
    closed = true;
    controller.abort();
  });

  (async function () {
    var settings = await getSettings();
    if (!settings.appToken) {
      safePost(port, { type: 'error', error: { code: 'NO_TOKEN', message: '还没填访问令牌，去插件设置里填一下', retryable: false } });
      safePost(port, { type: 'done' });
      return;
    }
    var response;
    try {
      response = await fetch(settings.serverUrl + '/v1/chat', {
        method: 'POST',
        headers: headersFor(settings),
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (!closed) {
        safePost(port, { type: 'error', error: { code: 'NETWORK', message: '连不上本地服务', retryable: true } });
        safePost(port, { type: 'done' });
      }
      return;
    }

    if (!response.ok || !response.body) {
      var info = await readError(response);
      safePost(port, { type: 'error', error: info });
      safePost(port, { type: 'done' });
      return;
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var parser = Buddy.createSseParser();
    var finished = false;
    var doneEmotion = null;

    function handle(events) {
      for (var i = 0; i < events.length; i += 1) {
        var event = events[i];
        if (event.event === 'delta') {
          try {
            var data = JSON.parse(event.data);
            if (data && typeof data.text === 'string') safePost(port, { type: 'delta', text: data.text });
          } catch (_error) { /* ignore malformed frame */ }
        } else if (event.event === 'error') {
          try {
            var err = JSON.parse(event.data);
            safePost(port, { type: 'error', error: err.error || { code: 'ERROR', message: '模型服务暂时不可用', retryable: true } });
          } catch (_error) { /* ignore */ }
          finished = true;
        } else if (event.event === 'done') {
          try {
            var done = JSON.parse(event.data);
            if (done && typeof done.emotion === 'string') doneEmotion = done.emotion;
          } catch (_error) { /* ignore malformed done frame */ }
          finished = true;
        }
      }
    }

    try {
      while (!closed) {
        var result = await reader.read();
        if (result.done) break;
        handle(parser.push(decoder.decode(result.value, { stream: true })));
      }
      handle(parser.push(decoder.decode()));
      handle(parser.flush());
      if (!closed) {
        safePost(port, doneEmotion ? { type: 'done', emotion: doneEmotion } : { type: 'done' });
      }
    } catch (error) {
      if (!closed && !finished) {
        safePost(port, { type: 'error', error: { code: 'NETWORK', message: '连接中断了', retryable: true } });
        safePost(port, { type: 'done' });
      }
    } finally {
      try { await reader.cancel(); } catch (_error) { /* already closed */ }
    }
  })();
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch (_error) {
    /* port closed */
  }
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'sm-net') return;

  port.onMessage.addListener(function (message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'chat') {
      streamChat(port, message.payload);
    }
  });
});

/* ---------- shared watch-time ledger ---------- */

/*
 * One budget for the whole browser, not one per tab.
 *
 * Every open douyin tab reports its own playback milliseconds here, and this
 * worker is the only thing that writes `smLimit`. That matters: chrome.storage
 * has no compare-and-swap, so if tabs each did `get` + `set` they would read
 * the same base and the last write would silently drop the other's time.
 *
 * The in-memory copy is the authority between writes; storage is just how it
 * survives a service-worker restart. The credit path is deliberately
 * synchronous (no async queue) — several tabs can tick in the same instant,
 * and awaiting anything between reading `limitLedger.state` and writing it
 * back would reopen the lost-update hole.
 */
var limitLedger = {
  loaded: false,
  state: { day: '', usedMs: 0, shutAt: 0 },
  settings: null,
  // A write is in flight; fold further changes into one trailing write.
  writing: false,
  dirty: false,
  // The exact object we last asked storage to hold. storage.onChanged echoes
  // our own writes back, and treating that echo as a remote change would make
  // the ledger jump backwards to a value we already superseded.
  lastWritten: null,
};

function loadLedger(callback) {
  if (limitLedger.loaded) {
    callback(limitLedger.state, limitLedger.settings);
    return;
  }
  chrome.storage.local.get(['settings', Buddy.LIMIT_KEY], function (data) {
    // Two tabs can tick while this read is in flight. Both entered loadLedger
    // before `loaded` was set, so both callbacks are queued; without this
    // guard the second would overwrite the state the first one just credited
    // and silently discard that tab's time.
    if (!limitLedger.loaded) {
      limitLedger.settings = Buddy.normalizeSettings(data && data.settings);
      limitLedger.state = Buddy.normalizeLimitState(data && data[Buddy.LIMIT_KEY]);
      limitLedger.loaded = true;
    }
    callback(limitLedger.state, limitLedger.settings);
  });
}

/** Persist the authoritative copy; at most one write in flight at a time. */
function saveLedger() {
  if (limitLedger.writing) {
    limitLedger.dirty = true;
    return;
  }
  limitLedger.writing = true;
  var snapshot = limitLedger.state;
  limitLedger.lastWritten = snapshot;
  chrome.storage.local.set({ [Buddy.LIMIT_KEY]: snapshot }, function () {
    limitLedger.writing = false;
    if (limitLedger.dirty) {
      limitLedger.dirty = false;
      saveLedger();
    }
  });
}

/**
 * Charge `deltaMs` of playback to the shared budget.
 *
 * Everything between reading the in-memory state and writing it back is
 * synchronous on purpose (see the comment on limitLedger), so two tabs ticking
 * at once cannot lose each other's time.
 */
function creditWatch(deltaMs, callback) {
  loadLedger(function () {
    var result = Buddy.limitCredit(limitLedger.state, deltaMs, Date.now(), limitLedger.settings);
    if (result.disabled) {
      callback({ ok: true, disabled: true, over: false, inCooldown: false, usedMs: 0 });
      return;
    }
    if (result.inCooldown) {
      // Do not touch storage: an early return must not extend the cooldown.
      callback({ ok: true, disabled: false, over: false, inCooldown: true, usedMs: 0 });
      return;
    }
    limitLedger.state = result.state;
    saveLedger();
    callback({
      ok: true,
      disabled: false,
      over: result.over,
      inCooldown: false,
      usedMs: result.usedMs,
    });
  });
}

/** Read the shared state without charging anything. */
function readWatch(callback) {
  loadLedger(function (state) {
    callback({ ok: true, state: state, settings: limitLedger.settings });
  });
}

/**
 * Record that the budget is spent and the door is now shut.
 *
 * Needed for the path that never charges anything: a page that loads with the
 * budget already gone announces 「时间到」 and closes, but no credit call runs,
 * so without this the cooldown would never be stamped — and every later open
 * would say 「时间到」 again instead of 「还敢点开」.
 *
 * Idempotent by design: when already in cooldown it does nothing, so two tabs
 * shutting down together cannot keep pushing the release time back.
 */
function stampShutdown(callback) {
  loadLedger(function () {
    var snap = Buddy.limitSnapshot(limitLedger.state, Date.now(), limitLedger.settings);
    if (snap.inCooldown) {
      callback({ ok: true, stamped: false, state: limitLedger.state });
      return;
    }
    limitLedger.state = Buddy.limitAfterShutdown(Date.now());
    saveLedger();
    callback({ ok: true, stamped: true, state: limitLedger.state });
  });
}

// Keep the cached copy honest if the popup (or another context) rewrites it.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.settings && limitLedger.loaded) {
    limitLedger.settings = Buddy.normalizeSettings(changes.settings.newValue);
  }
  if (changes[Buddy.LIMIT_KEY] && limitLedger.loaded) {
    var raw = changes[Buddy.LIMIT_KEY].newValue;
    var echo = limitLedger.lastWritten;
    // Our own write coming back: keep the newer in-memory value (it may have
    // advanced again while this write was in flight).
    var isOwnEcho = !!echo && !!raw && raw.day === echo.day &&
      raw.usedMs === echo.usedMs && raw.shutAt === echo.shutAt;
    if (!isOwnEcho) {
      // Something else cleared or reset the day; adopt it.
      limitLedger.state = Buddy.normalizeLimitState(raw);
    }
  }
});

/* ---------- closing a tab that ran out of watch time ---------- */

/**
 * Close the tab the message came from.
 *
 * Deliberately uses `sender.tab.id` instead of a tab id supplied by the page:
 * a content script must not be able to ask us to close *somebody else's* tab.
 * No "tabs" permission is needed for remove(); the URL is only readable here
 * because host_permissions already covers douyin.
 */
function closeSenderTab(sender) {
  var tab = sender && sender.tab;
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no sender tab' };
  }
  // Belt and braces: never close a tab that is not one of ours, even if a
  // future content script injection goes wrong.
  if (tab.url && !/^https?:\/\/([a-z0-9-]+\.)*(douyin|iesdouyin)\.com\//i.test(tab.url)) {
    return { ok: false, error: 'not a douyin tab' };
  }
  return new Promise(function (resolve) {
    try {
      chrome.tabs.remove(tab.id, function () {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: (error && error.message) || 'close failed' });
    }
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'sm:ping') {
    ping().then(sendResponse);
    return true;
  }
  if (message.type === 'sm:limitTick') {
    creditWatch(message.deltaMs, sendResponse);
    return true;
  }
  if (message.type === 'sm:limitState') {
    readWatch(sendResponse);
    return true;
  }
  if (message.type === 'sm:limitShutdown') {
    stampShutdown(sendResponse);
    return true;
  }
  if (message.type === 'sm:closeTab') {
    closeSenderTab(sender).then(sendResponse);
    return true;
  }
  if (message.type === 'sm:capture') {
    captureForAnalyze().then(sendResponse);
    return true;
  }
  if (message.type === 'sm:analyze') {
    analyze(message.payload).then(sendResponse);
    return true;
  }
  if (message.type === 'sm:icon') {
    sendResponse({ url: DEFAULT_ICON_PATH });
    return false;
  }
  return false;
});
