/* Service worker: the only place that talks to a model, whether that is the
 * local buddy server or the provider directly.
 *
 * Content scripts cannot call 127.0.0.1 directly (CORS), so every request goes
 * through here. Also handles screenshot capture + JPEG compression.
 *
 * Two modes, chosen by settings.mode:
 *   'server' — POST to the local Fastify service (the original path).
 *   'direct' — call the OpenAI-compatible provider with the user's own key.
 * Both build their prompts from the same shared modules and run the same
 * output filters, which is the only reason 'direct' can be trusted to sound
 * and behave the same.
 */
importScripts(
  'shared/persona.js',
  'shared/text-core.js',
  'shared/guards-core.js',
  'shared/voice-filter.js',
  'shared/zh-prompt.js',
  'shared/core.js'
);

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

/* ---------- direct mode: call the provider with the user's own key ---------- */

/*
 * This path exists so the extension works without a self-hosted server. It
 * deliberately mirrors the server's request construction instead of inventing
 * its own: same prompt modules, same output filters, same SSE frame shape. Any
 * difference here would show up as the cat talking differently depending on
 * which mode the user picked.
 *
 * What it cannot reproduce is the server's trend/slang injection, which needs
 * node:fs and a live hot-list fetch. Both candidate arrays are therefore empty
 * in this mode; the prompt already handles that (「（无）」).
 */
var DIRECT_CONFIG = {
  visionModel: 'deepseek-flash',
  chatModel: 'deepseek-flash',
  visionDetail: 'high',
  analyzeTimeoutMs: 12000,
  chatTimeoutMs: 60000,
};

function directError(code, message, retryable) {
  return { code: code, message: message, retryable: !!retryable };
}

/** Map an upstream failure to the codes the content script already handles. */
function directFailure(status, settings) {
  if (status === 401 || status === 403) {
    return directError('UPSTREAM_AUTH', '模型拒绝了访问令牌，检查设置里的 API Key', false);
  }
  if (status === 400 || status === 404) {
    return directError('MODEL_UNAVAILABLE', '模型名或能力不匹配', false);
  }
  if (status === 429) {
    return directError('RATE_LIMITED', '模型限流了，等一会儿再试', true);
  }
  if (status >= 500) {
    return directError('UPSTREAM_ERROR', '模型服务暂时不可用', true);
  }
  return directError('UPSTREAM_ERROR', '模型服务返回 HTTP ' + status, false);
}

/**
 * One POST to the OpenAI-compatible endpoint.
 *
 * Only https is allowed: settings.apiBaseUrl is already forced to https by
 * normalizeApiBaseUrl, and this is the call that carries the user's key, so a
 * downgrade to plain http would leak it over the wire.
 */
async function directRequest(settings, body, timeoutMs, signal) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
  }
  try {
    return await fetch(settings.apiBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + settings.apiKey,
        'content-type': 'application/json',
        accept: body.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function directThinkingParam() {
  // Matches the server's default (thinking disabled for latency).
  return { thinking: { type: 'disabled' } };
}

/** Pull message text out of a non-streaming OpenAI response. */
function directContent(json) {
  var choice = json && json.choices && json.choices[0];
  var content = choice && choice.message ? choice.message.content : null;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(function (part) {
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

/** The model is told to return JSON, but sometimes wraps it in a fence. */
function directParseJson(text) {
  var value = String(text || '').trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  var start = value.indexOf('{');
  var end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch (_error) {
    return null;
  }
}

/** Same shape the provider returns server-side, before finalizeAnalyzeResult. */
function directNormalizePayload(parsed) {
  var SmText = self.SmText;
  if (!parsed || typeof parsed !== 'object') return null;
  var summary = typeof parsed.summary === 'string' ? SmText.clampText(parsed.summary, 100) : '';
  var reaction = typeof parsed.reaction === 'string' ? SmText.clampText(parsed.reaction, 100) : '';
  if (!summary && !reaction) return null;
  var confidence =
    typeof parsed.confidence === 'number' && isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.6;
  return {
    summary: summary,
    keywords: SmText.dedupeStrings(Array.isArray(parsed.keywords) ? parsed.keywords : [], 5),
    mood: typeof parsed.mood === 'string' ? SmText.clampText(parsed.mood, 20) || '其他' : '其他',
    isAd: parsed.isAd === true,
    isLive: parsed.isLive === true,
    risk: parsed.risk === 'blocked' ? 'blocked' : 'ok',
    reaction: reaction,
    memeUsed: typeof parsed.memeUsed === 'string' ? SmText.clampText(parsed.memeUsed, 40) : null,
    confidence: confidence,
  };
}

/**
 * Direct-mode analyze.
 *
 * Returns the same `{ ok, data }` / `{ ok: false, error }` shape as the server
 * path so the content script does not need to know which mode is active.
 */
async function directAnalyze(payload, settings) {
  if (!settings.apiKey) {
    return { ok: false, error: directError('NO_API_KEY', '还没填 API Key，去插件设置里填一下', false) };
  }
  var SmPrompt = self.SmPrompt;
  var SmGuards = self.SmGuards;
  var input = {
    requestId: payload.requestId,
    app: payload.app,
    tone: payload.tone,
    dwellMs: payload.dwellMs,
    ocr: payload.ocr,
    images: Array.isArray(payload.images) ? payload.images.slice(0, 2) : [],
    recentReactions: Array.isArray(payload.recentReactions) ? payload.recentReactions : [],
    repeat: !!payload.repeat,
    videoBucket: payload.videoBucket || '',
    // No hot list and no slang lexicon in this mode: both need Node and a
    // network fetch the service worker has no business doing.
    trendCandidates: [],
    slangCandidates: [],
  };

  var startedAt = Date.now();
  var response;
  try {
    response = await directRequest(
      settings,
      {
        model: DIRECT_CONFIG.visionModel,
        messages: SmPrompt.buildAnalyzeMessages(input, DIRECT_CONFIG.visionDetail),
        stream: false,
        temperature: 0.7,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        ...directThinkingParam(),
      },
      DIRECT_CONFIG.analyzeTimeoutMs,
    );
  } catch (error) {
    var aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? directError('UPSTREAM_TIMEOUT', '模型响应超时，请重试', true)
        : directError('NETWORK', '连不上模型服务，检查网络和 API 地址', true),
    };
  }

  if (!response.ok) return { ok: false, error: directFailure(response.status, settings) };

  var json;
  try {
    json = await response.json();
  } catch (_error) {
    return { ok: false, error: directError('UPSTREAM_PROTOCOL', '模型返回的不是合法 JSON', true) };
  }
  if (json && json.error) {
    return { ok: false, error: directError('UPSTREAM_ERROR', '模型服务返回错误', true) };
  }

  var parsed = directParseJson(directContent(json));
  if (!parsed) {
    return { ok: false, error: directError('UPSTREAM_PROTOCOL', '模型输出格式不对，再试一次', true) };
  }
  var raw = directNormalizePayload(parsed);
  if (!raw) {
    return { ok: false, error: directError('UPSTREAM_PROTOCOL', '模型输出缺少摘要与反应', true) };
  }

  // The page's ad chip is passed as `confirmed`, exactly as the server does:
  // first-hand evidence needs no corroboration from the model's own text.
  var result = SmGuards.finalizeAnalyzeResult(raw, [], [], payload.tone, !!payload.adLabel);
  return {
    ok: true,
    data: { requestId: payload.requestId, ...result, latencyMs: Date.now() - startedAt },
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
  if (settings.mode === 'direct') return directAnalyze(payload, settings);
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
    if (settings.mode === 'direct') {
      await directStreamChat(port, payload, settings, controller, function () { return closed; });
      return;
    }
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

/**
 * Direct-mode chat.
 *
 * Emits the same `delta` / `error` / `done` frames the server path emits, and
 * runs the same two post-processors the server runs:
 *   - createMaomaoStreamFilter(), because a real model ignores the voice rules;
 *   - pickChatEmotion(), so `done.emotion` is the same colour hint.
 *
 * The filter is applied here rather than in the content script on purpose: the
 * server path is filtered server-side, so filtering client-side would make the
 * two modes disagree on punctuation and 喵.
 */
async function directStreamChat(port, payload, settings, controller, isClosed) {
  if (!settings.apiKey) {
    safePost(port, { type: 'error', error: directError('NO_API_KEY', '还没填 API Key，去插件设置里填一下', false) });
    safePost(port, { type: 'done' });
    return;
  }

  var SmPrompt = self.SmPrompt;
  var input = {
    requestId: payload.requestId,
    sessionId: payload.sessionId,
    tone: payload.tone,
    message: payload.message,
    context: payload.context || {},
    history: Array.isArray(payload.history) ? payload.history : [],
    trendCandidates: [],
    slangCandidates: [],
    privacyTextOnly: true,
    emotionTally: payload.emotionTally || {},
  };

  // Computed before the request, like the server does, so the hint reflects
  // this turn's user message rather than the reply.
  var emotionHint = SmPrompt.pickChatEmotion(input);

  var response;
  try {
    response = await directRequest(
      settings,
      {
        model: DIRECT_CONFIG.chatModel,
        messages: SmPrompt.buildChatMessages(input),
        stream: true,
        temperature: 0.92,
        max_tokens: 220,
        ...directThinkingParam(),
      },
      DIRECT_CONFIG.chatTimeoutMs,
      controller.signal,
    );
  } catch (error) {
    if (!isClosed()) {
      var aborted = error && error.name === 'AbortError';
      safePost(port, {
        type: 'error',
        error: aborted
          ? directError('UPSTREAM_TIMEOUT', '模型响应超时，请重试', true)
          : directError('NETWORK', '连不上模型服务，检查网络和 API 地址', true),
      });
      safePost(port, { type: 'done' });
    }
    return;
  }

  if (!response.ok || !response.body) {
    safePost(port, { type: 'error', error: directFailure(response.status, settings) });
    safePost(port, { type: 'done' });
    return;
  }

  var voice = input.tone === 'maomao' ? self.SmVoiceFilter.createMaomaoStreamFilter() : null;
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var finished = false;

  function emit(text) {
    if (!text || isClosed()) return;
    safePost(port, { type: 'delta', text: text });
  }

  try {
    while (!isClosed()) {
      var read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });

      var newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        var outcome = handleDirectLine(line);
        if (outcome === 'done') { finished = true; break; }
      }
      if (finished) break;
    }
    if (!finished) {
      var tail = handleDirectLine(buffer.replace(/\r$/, ''));
      if (tail === 'done') finished = true;
    }

    if (!isClosed()) {
      // The tail only exists after the last delta, so the 喵 lands once at the
      // end — same boundary the server's flush() uses.
      if (voice) emit(voice.flush());
      safePost(port, emotionHint ? { type: 'done', emotion: emotionHint } : { type: 'done' });
    }
  } catch (error) {
    if (!isClosed()) {
      var abortedRead = error && error.name === 'AbortError';
      safePost(port, {
        type: 'error',
        error: abortedRead
          ? directError('UPSTREAM_TIMEOUT', '模型响应超时，请重试', true)
          : directError('UPSTREAM_ERROR', '连接中断了', true),
      });
      safePost(port, { type: 'done' });
    }
  } finally {
    try { await reader.cancel(); } catch (_error) { /* already closed */ }
  }

  /** Parse one SSE line; returns 'done' when the upstream stream ended. */
  function handleDirectLine(line) {
    if (!line || line.charAt(0) === ':' || line.indexOf('data:') !== 0) return null;
    var data = line.slice(5).trim();
    if (!data) return null;
    if (data === '[DONE]') return 'done';

    var event;
    try {
      event = JSON.parse(data);
    } catch (_error) {
      return null;
    }
    if (event && event.error) {
      safePost(port, { type: 'error', error: directError('UPSTREAM_ERROR', '模型服务在流式响应中报错', true) });
      return 'done';
    }
    var choice = event && event.choices && event.choices[0];
    var content = choice && choice.delta ? choice.delta.content : null;
    if (typeof content !== 'string' || !content) return null;

    emit(voice ? voice.push(content) : content);
    return null;
  }
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

/*
 * Permission for the provider origin is requested by popup.js directly, not
 * here. chrome.permissions.request() only works while a user gesture is live,
 * and a gesture does not survive the sendMessage hop into this worker —
 * routing it through here made every prompt fail. Do not move it back.
 */

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
