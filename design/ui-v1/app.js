(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

  var EMOTIONS = {
    greet: {
      label: '打招呼',
      img: 'assets/emotions/greet-128.png',
      line: '在，球都给你留好位置了喵。',
      color: '#b9d7ff'
    },
    happy: {
      label: '开心',
      img: 'assets/emotions/happy-128.png',
      line: '算你有眼光，这波我认喵。',
      color: '#ffe6a8'
    },
    annoyed: {
      label: '嫌弃',
      img: 'assets/emotions/annoyed-128.png',
      line: '就这？你还能再刷三条喵。',
      color: '#d9c8ff'
    },
    angry: {
      label: '生气',
      img: 'assets/emotions/angry-128.png',
      line: '这广告过分了，别惯着它喵。',
      color: '#ffb7a5'
    },
    laugh: {
      label: '大笑',
      img: 'assets/emotions/laugh-128.png',
      line: '不行，这猫真把自己当回事了喵。',
      color: '#ffd9e4'
    },
    excited: {
      label: '兴奋',
      img: 'assets/emotions/excited-128.png',
      line: '这个我想看，往下刷喵。',
      color: '#b9f5d1'
    },
    sad: {
      label: '委屈',
      img: 'assets/emotions/sad-128.png',
      line: '别硬撑，视频先放一边，我在喵。',
      color: '#b9d7ff'
    },
    confused: {
      label: '疑惑',
      img: 'assets/emotions/confused-128.png',
      line: '等会儿，这剧情是不是少了一段喵？',
      color: '#e6ddff'
    },
    shocked: {
      label: '震惊',
      img: 'assets/emotions/shocked-128.png',
      line: '不是吧，它真敢这么干喵？',
      color: '#ffb7a5'
    }
  };

  var VIDEOS = [
    {
      caption: '猫主子又开始拆家了 #萌宠 #猫猫',
      meta: '视频 1 · 萌宠',
      still: 'assets/emotions/laugh-128.png',
      line: '这猫又在拆家，你还看得挺起劲喵？',
      mood: 'annoyed'
    },
    {
      caption: '打工人下班后的第一口饭 #vlog',
      meta: '视频 2 · 生活',
      still: 'assets/emotions/happy-128.png',
      line: '先吃饭，别拿手机当配菜喵。',
      mood: 'greet'
    },
    {
      caption: '这剧情反转得我头皮发麻 #悬疑',
      meta: '视频 3 · 影视',
      still: 'assets/emotions/shocked-128.png',
      line: '等会儿，刚才那个人是不是笑了喵？',
      mood: 'shocked'
    },
    {
      caption: '公园里的大爷遛狗 #治愈',
      meta: '视频 4 · 治愈',
      still: 'assets/emotions/greet-128.png',
      line: '这狗比你松弛，服了喵。',
      mood: 'annoyed'
    }
  ];

  function toast(message) {
    var node = $('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('on');
    clearTimeout(node._timer);
    node._timer = setTimeout(function () { node.classList.remove('on'); }, 2400);
  }

  function safeStore(key, value) {
    try {
      if (value === undefined) {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }
      localStorage.setItem(key, JSON.stringify(value));
      return value;
    } catch (_error) {
      return null;
    }
  }

  function downloadDialog() {
    var dialog = $('#downloadDialog');
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.className = 'preview-dialog';
    dialog.id = 'downloadDialog';
    dialog.setAttribute('aria-label', '安装说明');
    dialog.innerHTML =
      '<div class="dialog-pad">' +
        '<span class="kicker">安装说明</span>' +
        '<h2>安装包正在打包</h2>' +
        '<p>这是公开版的 UI 预览。正式扩展包会在“自带 API Key”接入完成后开放下载；现在可以先试玩交互 Demo，或先把模型配置走一遍。</p>' +
        '<div class="dialog-actions">' +
          '<button class="btn btn-ghost" type="button" data-dialog-close>关闭</button>' +
          '<a class="btn btn-primary" href="demo.html">去试玩</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dialog);

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
      if (event.target.closest('[data-dialog-close]')) dialog.close();
    });
    return dialog;
  }

  function initDownload() {
    $$('[data-download]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        downloadDialog().showModal();
      });
    });
    $$('[data-stage-ball]').forEach(function (button) {
      button.addEventListener('click', function () {
        window.location.href = 'demo.html';
      });
    });
  }

  function setEmotion(id) {
    var emotion = EMOTIONS[id] || EMOTIONS.greet;
    var ball = $('#ballFace');
    var chatAvatar = $('#chatAvatar');
    var label = $('#currentEmotionLabel');
    var sample = $('#emotionSample');
    if (ball) ball.src = emotion.img;
    if (chatAvatar) chatAvatar.src = emotion.img;
    if (label) label.textContent = emotion.label;
    if (sample) sample.textContent = emotion.line;
    $$('.emotion-btn').forEach(function (button) {
      button.setAttribute('aria-pressed', button.dataset.emotion === id ? 'true' : 'false');
    });
  }

  function initDemo() {
    var panel = $('#chatPanel');
    if (!panel) return;

    var messages = $('#chatMessages');
    var input = $('#chatInput');
    var send = $('#chatSend');
    var bubble = $('#chatBubble');
    var ball = $('#floatingBall');
    var videoImage = $('#videoStill');
    var caption = $('#videoCaption');
    var videoMeta = $('#videoMeta');
    var autoToggle = $('#autoComment');
    var videoIndex = 0;
    var bubbleTimer = 0;

    function scrollMessages() {
      messages.scrollTop = messages.scrollHeight;
    }

    function addMessage(role, text, emotionId) {
      var row = document.createElement('div');
      row.className = 'chat-msg ' + role;
      if (role === 'assistant' || role === 'a') {
        row.className = 'chat-msg a';
        var avatar = document.createElement('img');
        avatar.src = (EMOTIONS[emotionId] || EMOTIONS.greet).img;
        avatar.alt = '';
        var body = document.createElement('span');
        body.textContent = text;
        row.appendChild(avatar);
        row.appendChild(body);
      } else {
        row.textContent = text;
      }
      messages.appendChild(row);
      scrollMessages();
    }

    function showBubble(text, hold) {
      bubble.textContent = text;
      bubble.classList.add('on');
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(function () { bubble.classList.remove('on'); }, hold || 5200);
    }

    function openPanel() {
      panel.classList.add('on');
      panel.removeAttribute('inert');
      panel.setAttribute('aria-hidden', 'false');
      if (ball) ball.setAttribute('aria-expanded', 'true');
      setTimeout(function () { input.focus({ preventScroll: true }); }, 60);
      scrollMessages();
    }

    function closePanel() {
      panel.classList.remove('on');
      panel.setAttribute('aria-hidden', 'true');
      panel.setAttribute('inert', '');
      if (ball) ball.setAttribute('aria-expanded', 'false');
      if (ball) ball.focus({ preventScroll: true });
    }

    function replyTo(text) {
      var lower = text.toLowerCase();
      var emotion = 'annoyed';
      var reply = '你这话说得，我一时没想好怎么接喵。';

      if (/笑|哈哈|乐|梗/.test(lower)) {
        emotion = 'laugh';
        reply = '笑点在哪，你倒是说给我听听喵。';
      } else if (/气|烦|讨厌|过分/.test(lower)) {
        emotion = 'angry';
        reply = '谁惹你了？先说，我再决定骂谁喵。';
      } else if (/难过|委屈|哭|伤心|累/.test(lower)) {
        emotion = 'sad';
        reply = '别硬撑，视频先放一边，我在喵。';
      } else if (/谢谢|谢了|懂了|有道理/.test(lower)) {
        emotion = 'happy';
        reply = '算你有眼光喵。';
      } else if (/推荐|换一个|下一个|别的/.test(lower)) {
        emotion = 'annoyed';
        reply = '刷点不一样的，别老在这个坑里蹲着喵。';
      } else if (/视频|讲了啥|为什么|为啥|怎么|\?|？/.test(lower)) {
        emotion = 'confused';
        reply = '你问我？我这不也在看嘛，画面里那只猫明显心里有鬼喵。';
      } else if (/你好|在吗|嗨|hello|hi/.test(lower)) {
        emotion = 'greet';
        reply = '在，球都给你留好位置了喵。';
      }

      setEmotion(emotion);
      addMessage('assistant', reply, emotion);
    }

    function sendText(text) {
      var value = String(text || '').trim();
      if (!value) {
        input.focus();
        return;
      }
      addMessage('user', value);
      input.value = '';
      input.style.height = 'auto';
      setTimeout(function () { replyTo(value); }, 520);
    }

    function showVideo(index, announce) {
      videoIndex = (index + VIDEOS.length) % VIDEOS.length;
      var video = VIDEOS[videoIndex];
      videoImage.src = video.still;
      videoImage.alt = '';
      caption.textContent = video.caption;
      videoMeta.textContent = video.meta;
      setEmotion(video.mood);
      if (announce && autoToggle && autoToggle.checked) {
        setTimeout(function () {
          showBubble(video.line);
          addMessage('assistant', video.line, video.mood);
        }, 650);
      }
    }

    if (ball) {
      ball.addEventListener('click', function () {
        if (panel.classList.contains('on')) closePanel();
        else openPanel();
      });
    }
    var close = $('#chatClose');
    if (close) close.addEventListener('click', closePanel);
    if (bubble) {
      bubble.addEventListener('click', function () {
        showBubble('');
        openPanel();
      });
    }
    if (send) send.addEventListener('click', function () { sendText(input.value); });
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          sendText(input.value);
        }
      });
      input.addEventListener('input', function () {
        input.style.height = 'auto';
        input.style.height = Math.min(82, input.scrollHeight) + 'px';
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && panel.classList.contains('on')) closePanel();
    });

    $$('.emotion-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        setEmotion(button.dataset.emotion);
      });
    });

    $$('[data-prompt]').forEach(function (button) {
      button.addEventListener('click', function () {
        openPanel();
        sendText(button.dataset.prompt);
      });
    });

    var change = $('#changeVideo');
    if (change) {
      change.addEventListener('click', function () {
        showVideo(videoIndex + 1, true);
      });
    }

    var reset = $('#resetDemo');
    if (reset) {
      reset.addEventListener('click', function () {
        messages.innerHTML = '';
        addMessage('assistant', '来了？先刷你的，我看看今天又能刷到什么离谱东西喵。', 'greet');
        setEmotion('greet');
        if (bubble) bubble.classList.remove('on');
        toast('对话已重置');
      });
    }

    addMessage('assistant', '来了？先刷你的，我看看今天又能刷到什么离谱东西喵。', 'greet');
    showVideo(0, false);

    if (new URLSearchParams(window.location.search).get('open') === '1') {
      panel.style.transition = 'none';
      openPanel();
      setTimeout(function () { panel.style.transition = ''; }, 600);
    }
  }

  function initSetup() {
    var card = $('.setup-card');
    if (!card) return;

    var steps = $$('.step-panel');
    var tabs = $$('.step-rail button');
    var current = 1;
    var providerButtons = $$('.provider');
    var baseInput = $('#baseUrl');
    var modelInput = $('#model');
    var keyInput = $('#apiKey');
    var persona = $('#persona');
    var auto = $('#setupAuto');
    var previewLine = $('#previewLine');
    var previewModel = $('#previewModel');
    var previewPersona = $('#previewPersona');
    var status = $('#connectionStatus');

    function showStep(step) {
      current = Math.max(1, Math.min(3, step));
      steps.forEach(function (panel) {
        var active = Number(panel.dataset.step) === current;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
      tabs.forEach(function (tab) {
        var active = Number(tab.dataset.stepTarget) === current;
        if (active) tab.setAttribute('aria-current', 'step');
        else tab.removeAttribute('aria-current');
      });
      var heading = $('.setup-card h1, .setup-card h2');
      if (heading && current === 1) heading.focus({ preventScroll: true });
    }

    function selectedProvider() {
      var active = providerButtons.find(function (button) { return button.getAttribute('aria-pressed') === 'true'; });
      return active ? active.dataset.provider : 'deepseek';
    }

    function applyProvider(id) {
      providerButtons.forEach(function (button) {
        button.setAttribute('aria-pressed', button.dataset.provider === id ? 'true' : 'false');
      });
      if (id === 'deepseek') {
        baseInput.value = 'https://api.deepseek.com';
        modelInput.value = 'deepseek-chat';
      } else if (id === 'openai') {
        baseInput.value = 'https://api.openai.com/v1';
        modelInput.value = 'gpt-4o-mini';
      } else {
        baseInput.value = 'http://127.0.0.1:11434/v1';
        modelInput.value = 'qwen2.5:7b';
      }
      updateSummary();
    }

    function updateSummary() {
      if (previewModel) previewModel.textContent = modelInput.value || '未选择';
      if (previewPersona) previewPersona.textContent = persona.value;
      var lines = {
        '直白朋友': '这猫又在拆家，你还看得挺起劲喵？',
        '温柔搭子': '先歇会儿吧，视频又不会跑，我陪你喵。',
        '毒舌吐槽': '就这也能把你留住？你脾气真好喵。'
      };
      if (previewLine) previewLine.textContent = lines[persona.value] || lines['直白朋友'];
    }

    providerButtons.forEach(function (button) {
      button.addEventListener('click', function () { applyProvider(button.dataset.provider); });
    });

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { showStep(Number(tab.dataset.stepTarget)); });
    });

    $$('[data-next-step]').forEach(function (button) {
      button.addEventListener('click', function () { showStep(current + 1); });
    });
    $$('[data-prev-step]').forEach(function (button) {
      button.addEventListener('click', function () { showStep(current - 1); });
    });

    var showKey = $('#toggleKey');
    if (showKey && keyInput) {
      showKey.addEventListener('click', function () {
        var visible = keyInput.type === 'text';
        keyInput.type = visible ? 'password' : 'text';
        showKey.textContent = visible ? '显示' : '隐藏';
        showKey.setAttribute('aria-label', visible ? '显示 API Key' : '隐藏 API Key');
      });
    }

    var test = $('#testConnection');
    if (test) {
      test.addEventListener('click', function () {
        if (!keyInput.value.trim()) {
          status.className = 'connection-status err';
          status.textContent = '先填 API Key，再测试连接。';
          keyInput.focus();
          return;
        }
        var url = baseInput.value.trim();
        if (!/^https?:\/\//i.test(url)) {
          status.className = 'connection-status err';
          status.textContent = 'Base URL 需要以 http:// 或 https:// 开头。';
          baseInput.focus();
          return;
        }
        test.disabled = true;
        test.textContent = '测试中…';
        status.className = 'connection-status';
        status.textContent = '正在检查地址和密钥格式…';
        setTimeout(function () {
          test.disabled = false;
          test.textContent = '测试连接';
          status.className = 'connection-status ok';
          status.textContent = '格式通过。演示页不会真的发送密钥；正式扩展会由 background service worker 发起请求。';
          toast('配置格式通过');
        }, 900);
      });
    }

    var save = $('#saveSetup');
    if (save) {
      save.addEventListener('click', function () {
        safeStore('smDemoConfig', {
          provider: selectedProvider(),
          baseUrl: baseInput.value.trim(),
          model: modelInput.value.trim(),
          persona: persona.value,
          autoComment: !!(auto && auto.checked)
        });
        toast('配置已保存在本机浏览器');
      });
    }

    persona.addEventListener('change', updateSummary);
    modelInput.addEventListener('input', updateSummary);
    applyProvider('deepseek');
    updateSummary();
    showStep(1);

    var requestedStep = Number(new URLSearchParams(window.location.search).get('step'));
    if (requestedStep >= 1 && requestedStep <= 3) showStep(requestedStep);

    var saved = safeStore('smDemoConfig');
    if (saved) {
      if (saved.provider) applyProvider(saved.provider);
      if (saved.baseUrl) baseInput.value = saved.baseUrl;
      if (saved.model) modelInput.value = saved.model;
      if (saved.persona) persona.value = saved.persona;
      if (auto) auto.checked = !!saved.autoComment;
      updateSummary();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initDownload();
    initDemo();
    initSetup();
  });
})();
