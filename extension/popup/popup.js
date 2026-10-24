(function () {
  'use strict';

  var Buddy = window.Buddy;
  var fields = {
    enabled: document.getElementById('enabled'),
    proactive: document.getElementById('proactive'),
    captureEnabled: document.getElementById('captureEnabled'),
    dwellSeconds: document.getElementById('dwellSeconds'),
    repeatDwellSeconds: document.getElementById('repeatDwellSeconds'),
    cooldownSeconds: document.getElementById('cooldownSeconds'),
    autoOpenPanel: document.getElementById('autoOpenPanel'),
    mode: document.getElementById('mode'),
    serverUrl: document.getElementById('serverUrl'),
    appToken: document.getElementById('appToken'),
    apiKey: document.getElementById('apiKey'),
    apiBaseUrl: document.getElementById('apiBaseUrl'),
    deviceId: document.getElementById('deviceId'),
    ballSize: document.getElementById('ballSize'),
    bubbleSeconds: document.getElementById('bubbleSeconds'),
    emotionHoldSeconds: document.getElementById('emotionHoldSeconds'),
    limitEnabled: document.getElementById('limitEnabled'),
    limitMinutes: document.getElementById('limitMinutes'),
    limitCooldownMinutes: document.getElementById('limitCooldownMinutes'),
    limitCloseSeconds: document.getElementById('limitCloseSeconds'),
    nudgeLimitCount: document.getElementById('nudgeLimitCount'),
  };
  var ballSizeLabel = document.getElementById('ballSizeLabel');
  var bubbleSecondsLabel = document.getElementById('bubbleSecondsLabel');
  var emotionHoldSecondsLabel = document.getElementById('emotionHoldSecondsLabel');
  var limitCloseSecondsLabel = document.getElementById('limitCloseSecondsLabel');
  var nudgeLimitCountLabel = document.getElementById('nudgeLimitCountLabel');
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('statusText');
  var statusMeta = document.getElementById('statusMeta');
  var toastNode = document.getElementById('toast');
  var toastTimer = 0;

  function toast(message) {
    toastNode.textContent = message;
    toastNode.classList.add('on');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastNode.classList.remove('on');
    }, 2200);
  }

  function fill(settings) {
    fields.enabled.checked = settings.enabled;
    fields.proactive.checked = settings.proactive;
    fields.captureEnabled.checked = settings.captureEnabled;
    fields.dwellSeconds.value = settings.dwellSeconds;
    fields.repeatDwellSeconds.value = settings.repeatDwellSeconds;
    fields.cooldownSeconds.value = settings.cooldownSeconds;
    fields.autoOpenPanel.checked = settings.autoOpenPanel;
    fields.mode.value = settings.mode;
    fields.serverUrl.value = settings.serverUrl;
    fields.appToken.value = settings.appToken;
    fields.apiKey.value = settings.apiKey;
    fields.apiBaseUrl.value = settings.apiBaseUrl;
    fields.deviceId.value = settings.deviceId;
    syncModeVisibility();
    fields.ballSize.value = settings.ballSize;
    ballSizeLabel.textContent = settings.ballSize;
    fields.bubbleSeconds.value = settings.bubbleSeconds;
    bubbleSecondsLabel.textContent = settings.bubbleSeconds;
    fields.emotionHoldSeconds.value = settings.emotionHoldSeconds;
    emotionHoldSecondsLabel.textContent = settings.emotionHoldSeconds;
    fields.limitEnabled.checked = settings.limitEnabled;
    fields.limitMinutes.value = settings.limitMinutes;
    fields.limitCooldownMinutes.value = settings.limitCooldownMinutes;
    fields.limitCloseSeconds.value = settings.limitCloseSeconds;
    limitCloseSecondsLabel.textContent = settings.limitCloseSeconds;
    fields.nudgeLimitCount.value = settings.nudgeLimitCount;
    nudgeLimitCountLabel.textContent = settings.nudgeLimitCount;
  }

  function readForm() {
    return Buddy.normalizeSettings({
      enabled: fields.enabled.checked,
      proactive: fields.proactive.checked,
      captureEnabled: fields.captureEnabled.checked,
      dwellSeconds: fields.dwellSeconds.value,
      repeatDwellSeconds: fields.repeatDwellSeconds.value,
      cooldownSeconds: fields.cooldownSeconds.value,
      autoOpenPanel: fields.autoOpenPanel.checked,
      mode: fields.mode.value,
      serverUrl: fields.serverUrl.value,
      appToken: fields.appToken.value,
      apiKey: fields.apiKey.value,
      apiBaseUrl: fields.apiBaseUrl.value,
      deviceId: fields.deviceId.value,
      ballSize: fields.ballSize.value,
      bubbleSeconds: fields.bubbleSeconds.value,
      emotionHoldSeconds: fields.emotionHoldSeconds.value,
      limitEnabled: fields.limitEnabled.checked,
      limitMinutes: fields.limitMinutes.value,
      limitCooldownMinutes: fields.limitCooldownMinutes.value,
      limitCloseSeconds: fields.limitCloseSeconds.value,
      nudgeLimitCount: fields.nudgeLimitCount.value,
    });
  }

  function setStatus(kind, text, meta) {
    dot.className = 'dot ' + (kind || '');
    statusText.textContent = text;
    statusMeta.textContent = meta || '';
  }

  /** Only show the fields that the selected mode actually uses. */
  function syncModeVisibility() {
    var direct = fields.mode.value === 'direct';
    document.getElementById('serverFields').hidden = direct;
    document.getElementById('directFields').hidden = !direct;
  }

  function checkConnection() {
    if (fields.mode.value === 'direct') {
      checkDirect();
      return;
    }
    setStatus('', '检查服务中', '');
    chrome.runtime.sendMessage({ type: 'sm:ping' }, function (response) {
      if (chrome.runtime.lastError || !response) {
        setStatus('bad', '插件后台无响应', '重新加载扩展');
        return;
      }
      if (!response.ok) {
        var code = response.error && response.error.code ? response.error.code : 'ERROR';
        var message = response.error && response.error.message ? response.error.message : '连不上';
        setStatus('bad', message, code);
        return;
      }
      setStatus('ok', '已连接', (response.provider || '') + ' · ' + (response.latencyMs || 0) + 'ms');
      if (response.providerFallback) {
        // Configured for deepseek but no key: say so instead of silently
        // pretending the mock replies are real.
        toast('配置的是 ' + (response.configuredProvider || 'deepseek') + '，但没读到密钥，正在用 mock');
      } else if (response.provider === 'mock') {
        toast('当前是 mock 模式，回复是本地假数据');
      }
    });
  }

  /**
   * Direct mode has no local service to ping, so the worker asks the provider
   * whether the key is good: GET /models costs no tokens and answers exactly
   * that. Checking only local state (key non-empty, origin granted) used to
   * report ready for a wrong key, which is the one thing this button exists to
   * catch.
   *
   * The permission is still checked first: without it the request fails as a
   * network error, which would read as "your key is wrong".
   */
  function checkDirect() {
    var key = fields.apiKey.value.trim();
    var base = Buddy.normalizeApiBaseUrl(fields.apiBaseUrl.value);
    if (!key) {
      setStatus('bad', '还没填 API Key', 'direct');
      return;
    }
    var origin;
    try {
      origin = new URL(base).origin + '/*';
    } catch (_error) {
      setStatus('bad', 'API 地址不合法', 'direct');
      return;
    }
    setStatus('', '正在连接模型', 'direct');
    chrome.permissions.contains({ origins: [origin] }, function (granted) {
      if (chrome.runtime.lastError) {
        setStatus('bad', '无法检查权限', 'direct');
        return;
      }
      if (!granted) {
        setStatus('', '已填 Key，保存时会请求权限', origin.replace('/*', ''));
        return;
      }
      chrome.runtime.sendMessage({ type: 'sm:ping' }, function (response) {
        if (chrome.runtime.lastError || !response) {
          setStatus('bad', '插件后台无响应', '重新加载扩展');
          return;
        }
        if (!response.ok) {
          var code = response.error && response.error.code ? response.error.code : 'ERROR';
          var message = response.error && response.error.message ? response.error.message : '连不上模型服务';
          setStatus('bad', message, code);
          return;
        }
        setStatus('ok', '直连已就绪', origin.replace('/*', '') + ' · ' + (response.latencyMs || 0) + 'ms');
      });
    });
  }

  chrome.storage.local.get('settings', function (data) {
    var stored = data && data.settings;
    var settings = Buddy.normalizeSettings(stored);
    fill(settings);
    document.body.dataset.ready = '1';
    // Only persist on first run (to keep the generated device id); never
    // clobber settings that the content script or another tab just wrote.
    if (!stored) chrome.storage.local.set({ settings: settings });
    checkConnection();
  });

  document.getElementById('form').addEventListener('submit', function (event) {
    event.preventDefault();
    var settings = readForm();

    function persist() {
      chrome.storage.local.set({ settings: settings }, function () {
        fill(settings);
        toast('已保存');
        checkConnection();
      });
    }

    if (settings.mode !== 'direct' || !settings.apiKey) {
      persist();
      return;
    }

    // Called straight from this page, synchronously, inside the submit handler.
    // chrome.permissions.request() only works while a user gesture is live, and
    // a gesture does NOT survive a sendMessage hop into the service worker —
    // routing this through the background rejected the prompt every time.
    var origin;
    try {
      origin = new URL(settings.apiBaseUrl).origin + '/*';
    } catch (_error) {
      toast('API 地址不合法');
      return;
    }
    chrome.permissions.request({ origins: [origin] }, function (granted) {
      if (chrome.runtime.lastError) {
        toast(chrome.runtime.lastError.message || '无法请求权限');
        return;
      }
      if (!granted) {
        toast('没有授权访问该地址，直连模式无法使用');
        return;
      }
      persist();
    });
  });

  document.getElementById('ping').addEventListener('click', checkConnection);

  fields.ballSize.addEventListener('input', function () {
    ballSizeLabel.textContent = fields.ballSize.value;
  });

  fields.bubbleSeconds.addEventListener('input', function () {
    bubbleSecondsLabel.textContent = fields.bubbleSeconds.value;
  });

  fields.emotionHoldSeconds.addEventListener('input', function () {
    emotionHoldSecondsLabel.textContent = fields.emotionHoldSeconds.value;
  });

  fields.limitCloseSeconds.addEventListener('input', function () {
    limitCloseSecondsLabel.textContent = fields.limitCloseSeconds.value;
  });

  fields.nudgeLimitCount.addEventListener('input', function () {
    nudgeLimitCountLabel.textContent = fields.nudgeLimitCount.value;
  });

  fields.mode.addEventListener('change', function () {
    syncModeVisibility();
    checkConnection();
  });

  fields.serverUrl.addEventListener('change', function () {
    var normalized = Buddy.normalizeServerUrl(fields.serverUrl.value);
    fields.serverUrl.value = normalized;
  });

  fields.apiBaseUrl.addEventListener('change', function () {
    fields.apiBaseUrl.value = Buddy.normalizeApiBaseUrl(fields.apiBaseUrl.value);
    checkConnection();
  });

  fields.apiKey.addEventListener('input', function () {
    if (fields.apiKey.value !== fields.apiKey.value.trim()) {
      fields.apiKey.value = fields.apiKey.value.trim();
    }
  });

  fields.appToken.addEventListener('input', function () {
    if (fields.appToken.value !== fields.appToken.value.trim()) {
      fields.appToken.value = fields.appToken.value.trim();
    }
  });
})();
