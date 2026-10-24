(function () {
  'use strict';

  var Buddy = window.Buddy;
  var fields = {
    enabled: document.getElementById('enabled'),
    dwellSeconds: document.getElementById('dwellSeconds'),
    repeatDwellSeconds: document.getElementById('repeatDwellSeconds'),
    cooldownSeconds: document.getElementById('cooldownSeconds'),
    autoOpenPanel: document.getElementById('autoOpenPanel'),
    serverUrl: document.getElementById('serverUrl'),
    appToken: document.getElementById('appToken'),
    deviceId: document.getElementById('deviceId'),
    ballSize: document.getElementById('ballSize'),
    bubbleSeconds: document.getElementById('bubbleSeconds'),
    emotionHoldSeconds: document.getElementById('emotionHoldSeconds'),
    limitEnabled: document.getElementById('limitEnabled'),
    limitMinutes: document.getElementById('limitMinutes'),
    limitCooldownMinutes: document.getElementById('limitCooldownMinutes'),
    limitCloseSeconds: document.getElementById('limitCloseSeconds'),
  };
  var ballSizeLabel = document.getElementById('ballSizeLabel');
  var bubbleSecondsLabel = document.getElementById('bubbleSecondsLabel');
  var emotionHoldSecondsLabel = document.getElementById('emotionHoldSecondsLabel');
  var limitCloseSecondsLabel = document.getElementById('limitCloseSecondsLabel');
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
    fields.dwellSeconds.value = settings.dwellSeconds;
    fields.repeatDwellSeconds.value = settings.repeatDwellSeconds;
    fields.cooldownSeconds.value = settings.cooldownSeconds;
    fields.autoOpenPanel.checked = settings.autoOpenPanel;
    fields.serverUrl.value = settings.serverUrl;
    fields.appToken.value = settings.appToken;
    fields.deviceId.value = settings.deviceId;
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
  }

  function readForm() {
    return Buddy.normalizeSettings({
      enabled: fields.enabled.checked,
      dwellSeconds: fields.dwellSeconds.value,
      repeatDwellSeconds: fields.repeatDwellSeconds.value,
      cooldownSeconds: fields.cooldownSeconds.value,
      autoOpenPanel: fields.autoOpenPanel.checked,
      serverUrl: fields.serverUrl.value,
      appToken: fields.appToken.value,
      deviceId: fields.deviceId.value,
      ballSize: fields.ballSize.value,
      bubbleSeconds: fields.bubbleSeconds.value,
      emotionHoldSeconds: fields.emotionHoldSeconds.value,
      limitEnabled: fields.limitEnabled.checked,
      limitMinutes: fields.limitMinutes.value,
      limitCooldownMinutes: fields.limitCooldownMinutes.value,
      limitCloseSeconds: fields.limitCloseSeconds.value,
    });
  }

  function setStatus(kind, text, meta) {
    dot.className = 'dot ' + (kind || '');
    statusText.textContent = text;
    statusMeta.textContent = meta || '';
  }

  function checkConnection() {
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
    chrome.storage.local.set({ settings: settings }, function () {
      fill(settings);
      toast('已保存');
      checkConnection();
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

  fields.serverUrl.addEventListener('change', function () {
    var normalized = Buddy.normalizeServerUrl(fields.serverUrl.value);
    fields.serverUrl.value = normalized;
  });

  fields.appToken.addEventListener('input', function () {
    if (fields.appToken.value !== fields.appToken.value.trim()) {
      fields.appToken.value = fields.appToken.value.trim();
    }
  });
})();
