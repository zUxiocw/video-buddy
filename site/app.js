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
        '<p>这是公开版的 UI 预览。当前插件使用 Chrome MV3 + 本机 Fastify 服务；正式扩展包会配合 <code>server/</code> 一起发布。现在可以先试玩，或先走一遍本地服务配置。</p>' +
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
    var phone = $('.phone');
    var videoImage = $('#videoStill');
    var caption = $('#videoCaption');
    var videoMeta = $('#videoMeta');
    var autoToggle = $('#autoComment');
    var videoIndex = 0;
    var bubbleTimer = 0;

    var ballPos = { x: 0, y: 0 };
    var dragStart = null;
    var ballMoved = false;
    var pointerActivated = false;
    var limitOverlay = $('#phoneLimit');
    var limitLine = $('#phoneLimitLine');
    var limitCountdown = $('#phoneLimitCountdown');
    var limitClosedNote = $('#phoneClosedNote');
    var limitReopen = $('#phoneReopen');
    var limitReset = $('#phoneResetLimit');
    var startLimit = $('#startLimitDemo');
    var stopLimit = $('#stopLimitDemo');
    var limitBudgetLabel = $('#demoLimitBudget');
    var limitUsedLabel = $('#demoLimitUsed');
    var limitFill = $('#demoLimitFill');
    var limitTimers = [];
    var limitInterval = 0;
    var limitBudgetMinutes = 30;

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function phoneMetrics() {
      var ballW = ball ? ball.offsetWidth : 74;
      var ballH = ball ? ball.offsetHeight : 74;
      var minX = 10;
      var minY = 58;
      return {
        ballW: ballW,
        ballH: ballH,
        minX: minX,
        minY: minY,
        maxX: Math.max(minX, (phone ? phone.clientWidth : 390) - ballW - 10),
        maxY: Math.max(minY, (phone ? phone.clientHeight : 780) - ballH - 10)
      };
    }

    function placeBall(left, top, quiet) {
      if (!ball || !phone) return;
      var m = phoneMetrics();
      ballPos.x = clamp(left, m.minX, m.maxX);
      ballPos.y = clamp(top, m.minY, m.maxY);
      ball.style.left = ballPos.x + 'px';
      ball.style.top = ballPos.y + 'px';
      ball.style.right = 'auto';
      ball.style.bottom = 'auto';
      if (!quiet) layoutBubble();
    }

    function layoutBubble() {
      if (!bubble || !ball || !phone) return;
      var width = phone.clientWidth;
      var height = phone.clientHeight;
      var bubbleW = bubble.offsetWidth;
      var bubbleH = bubble.offsetHeight;
      if (!width || !height || !bubbleW || !bubbleH) return;
      var ballW = ball.offsetWidth;
      var ballH = ball.offsetHeight;
      var toRight = ballPos.x + ballW / 2 < width / 2;
      var left = toRight ? ballPos.x + ballW + 10 : ballPos.x - bubbleW - 10;
      left = clamp(left, 10, Math.max(10, width - bubbleW - 10));
      var top = clamp(ballPos.y + ballH / 2 - bubbleH * 0.8, 58, Math.max(58, height - bubbleH - 10));
      bubble.style.left = left + 'px';
      bubble.style.top = top + 'px';
      bubble.style.right = 'auto';
      bubble.style.bottom = 'auto';
      bubble.classList.toggle('bubble-right', toRight);
    }

    function resetBall() {
      if (!ball || !phone) return;
      var m = phoneMetrics();
      placeBall(phone.clientWidth - m.ballW - 18, phone.clientHeight - m.ballH - 96, false);
      layoutBubble();
    }

    function endBallDrag(event) {
      if (!dragStart || event.pointerId !== dragStart.pointerId) return;
      var wasMoved = ballMoved;
      dragStart = null;
      ballMoved = false;
      pointerActivated = true;
      window.setTimeout(function () { pointerActivated = false; }, 800);
      if (ball) ball.classList.remove('dragging');
      try { ball.releasePointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
      if (wasMoved) return;
      if (panel.classList.contains('on')) closePanel();
      else openPanel();
    }

    function cancelBallDrag() {
      dragStart = null;
      ballMoved = false;
      if (ball) ball.classList.remove('dragging');
    }

    function formatClock(totalSeconds) {
      var safe = Math.max(0, Math.round(totalSeconds));
      var minutes = Math.floor(safe / 60);
      var seconds = safe % 60;
      return minutes + ':' + String(seconds).padStart(2, '0');
    }

    function syncLimitBudget() {
      if (limitBudgetLabel) limitBudgetLabel.textContent = formatClock(limitBudgetMinutes * 60);
      if (limitUsedLabel) limitUsedLabel.textContent = formatClock(limitBudgetMinutes * 60 * 0.79);
      if (limitFill) limitFill.style.width = '79%';
      $$('[data-demo-limit]').forEach(function (button) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.demoLimit) === limitBudgetMinutes));
      });
    }

    function clearLimitTimers() {
      window.clearInterval(limitInterval);
      limitInterval = 0;
      limitTimers.forEach(function (id) { window.clearTimeout(id); });
      limitTimers = [];
    }

    function setLimitState(state) {
      if (!limitOverlay) return;
      limitOverlay.dataset.state = state;
      limitOverlay.setAttribute('aria-hidden', state === 'off' ? 'true' : 'false');
      if (startLimit) startLimit.disabled = state !== 'off';
      if (stopLimit) stopLimit.hidden = state === 'off';
    }

    function resetLimitDemo(announce) {
      clearLimitTimers();
      setLimitState('off');
      if (announce !== false) {
        toast('页面已恢复，可以重新试玩');
        if (startLimit) startLimit.focus({ preventScroll: true });
      }
    }

    function showLimitClosed(kind) {
      clearLimitTimers();
      setLimitState('closed');
      if (limitClosedNote) {
        limitClosedNote.textContent = kind === 'back'
          ? '冷却还没结束。再打开，它还会关。'
          : '冷却 10 分钟内再打开，它会说一句再关一次。';
      }
      window.setTimeout(function () {
        if (limitReopen) limitReopen.focus({ preventScroll: true });
      }, 40);
    }

    function showLimitWarning(kind) {
      if (!limitOverlay) return;
      clearLimitTimers();
      closePanel();
      setLimitState('warn');
      var isBack = kind === 'back';
      var seconds = isBack ? 2 : 5;
      var suffix = isBack ? ' 秒后继续关页' : ' 秒后关闭这个标签页';
      var left = seconds;
      if (limitLine) limitLine.textContent = isBack ? '还敢点开，不给你刷了喵' : '差不多了哦，本喵要下班了喵';
      if (limitCountdown) limitCountdown.textContent = left + suffix;
      limitOverlay.focus({ preventScroll: true });
      if (phone) {
        var rect = phone.getBoundingClientRect();
        if (rect.top < 8 || rect.bottom > window.innerHeight - 8) {
          var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          phone.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
        }
      }
      limitInterval = window.setInterval(function () {
        left -= 1;
        if (left > 0 && limitCountdown) limitCountdown.textContent = left + suffix;
      }, 1000);
      limitTimers.push(window.setTimeout(function () { showLimitClosed(kind); }, seconds * 1000));
    }

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
      layoutBubble();
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
      ball.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 || !phone) return;
        dragStart = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          baseX: ballPos.x,
          baseY: ballPos.y
        };
        ballMoved = false;
        try { ball.setPointerCapture(event.pointerId); } catch (_error) { /* synthetic events */ }
      });

      ball.addEventListener('pointermove', function (event) {
        if (!dragStart || event.pointerId !== dragStart.pointerId) return;
        var dx = event.clientX - dragStart.startX;
        var dy = event.clientY - dragStart.startY;
        if (!ballMoved && Math.hypot(dx, dy) > 4) {
          ballMoved = true;
          ball.classList.add('dragging');
        }
        if (!ballMoved) return;
        placeBall(dragStart.baseX + dx, dragStart.baseY + dy);
      });

      ball.addEventListener('pointerup', endBallDrag);
      ball.addEventListener('pointercancel', cancelBallDrag);

      ball.addEventListener('keydown', function (event) {
        var step = event.shiftKey ? 20 : 8;
        var dx = 0;
        var dy = 0;
        if (event.key === 'ArrowLeft') dx = -step;
        else if (event.key === 'ArrowRight') dx = step;
        else if (event.key === 'ArrowUp') dy = -step;
        else if (event.key === 'ArrowDown') dy = step;
        else if (event.key === 'Home') {
          event.preventDefault();
          resetBall();
          return;
        } else {
          return;
        }
        event.preventDefault();
        placeBall(ballPos.x + dx, ballPos.y + dy);
      });

      // The button is activated on pointerup. Suppress the compatibility click
      // that follows a pointer gesture; keyboard and AT clicks still work.
      ball.addEventListener('click', function () {
        if (pointerActivated) return;
        if (panel.classList.contains('on')) closePanel();
        else openPanel();
      });
      ball.addEventListener('dragstart', function (event) { event.preventDefault(); });
      ball.addEventListener('selectstart', function (event) { event.preventDefault(); });
      var face = ball.querySelector('img');
      if (face) face.draggable = false;
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
      if (event.key !== 'Escape') return;
      if (limitOverlay && limitOverlay.dataset.state !== 'off') {
        resetLimitDemo(true);
        return;
      }
      if (panel.classList.contains('on')) closePanel();
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
        resetLimitDemo(false);
        toast('对话已重置');
      });
    }

    $$('[data-demo-limit]').forEach(function (button) {
      button.addEventListener('click', function () {
        limitBudgetMinutes = Number(button.dataset.demoLimit) || 30;
        syncLimitBudget();
      });
    });
    if (startLimit) startLimit.addEventListener('click', function () { showLimitWarning('over'); });
    if (stopLimit) stopLimit.addEventListener('click', function () { resetLimitDemo(true); });
    if (limitReopen) limitReopen.addEventListener('click', function () { showLimitWarning('back'); });
    if (limitReset) limitReset.addEventListener('click', function () { resetLimitDemo(true); });

    addMessage('assistant', '来了？先刷你的，我看看今天又能刷到什么离谱东西喵。', 'greet');
    showVideo(0, false);
    syncLimitBudget();
    window.requestAnimationFrame(resetBall);
    window.addEventListener('resize', function () {
      if (!ball) return;
      placeBall(ballPos.x, ballPos.y);
    });

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
    var serverInput = $('#serverUrl');
    var tokenInput = $('#appToken');
    var deviceInput = $('#deviceId');
    var persona = $('#persona');
    var replyLength = $('#replyLength');
    var auto = $('#setupAuto');
    var vision = $('#setupVision');
    var previewServer = $('#previewServer');
    var previewToken = $('#previewToken');
    var previewPersona = $('#previewPersona');
    var previewLine = $('#previewLine');
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
    }

    function updateSummary() {
      if (previewServer) previewServer.textContent = serverInput.value.trim() || 'http://127.0.0.1:8787';
      if (previewToken) {
        var token = tokenInput.value.trim();
        previewToken.textContent = token ? '已填写（' + token.length + ' 位）' : '未填写';
      }
      if (previewPersona) previewPersona.textContent = persona.value;
      var lines = {
        '直白朋友': '这猫又在拆家，你还看得挺起劲喵？',
        '温柔搭子': '先歇会儿吧，视频又不会跑，我陪你喵。',
        '毒舌吐槽': '就这也能把你留住？你脾气真好喵。'
      };
      if (previewLine) previewLine.textContent = lines[persona.value] || lines['直白朋友'];
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { showStep(Number(tab.dataset.stepTarget)); });
    });

    $$('[data-next-step]').forEach(function (button) {
      button.addEventListener('click', function () { showStep(current + 1); });
    });
    $$('[data-prev-step]').forEach(function (button) {
      button.addEventListener('click', function () { showStep(current - 1); });
    });

    var copy = $('[data-copy-command]');
    if (copy) {
      copy.addEventListener('click', function () {
        var block = $('#serverCommands');
        var text = block ? block.innerText : '';
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            toast('启动命令已复制');
          }).catch(function () {
            toast('复制失败，请手动选择命令');
          });
        } else {
          toast('复制失败，请手动选择命令');
        }
      });
    }

    var showKey = $('#toggleKey');
    if (showKey && tokenInput) {
      showKey.addEventListener('click', function () {
        var visible = tokenInput.type === 'text';
        tokenInput.type = visible ? 'password' : 'text';
        showKey.textContent = visible ? '显示' : '隐藏';
        showKey.setAttribute('aria-label', visible ? '显示访问令牌' : '隐藏访问令牌');
      });
    }

    var test = $('#testConnection');
    if (test) {
      test.addEventListener('click', function () {
        if (!tokenInput.value.trim()) {
          status.className = 'connection-status err';
          status.textContent = '先填访问令牌（APP_TOKEN），再测试连接。';
          tokenInput.focus();
          return;
        }
        var url = serverInput.value.trim();
        if (!/^https?:\/\//i.test(url)) {
          status.className = 'connection-status err';
          status.textContent = '服务地址需要以 http:// 或 https:// 开头。';
          serverInput.focus();
          return;
        }
        test.disabled = true;
        test.textContent = '测试中…';
        status.className = 'connection-status';
        status.textContent = '正在检查地址和访问令牌格式…';
        setTimeout(function () {
          test.disabled = false;
          test.textContent = '测试连接';
          status.className = 'connection-status ok';
          status.textContent = '格式通过。演示页不会请求 /health；正式扩展会在后台验证服务。';
          toast('本地服务配置格式通过');
        }, 900);
      });
    }

    var save = $('#saveSetup');
    if (save) {
      save.addEventListener('click', function () {
        safeStore('smDemoConfig', {
          serverUrl: serverInput.value.trim(),
          appToken: tokenInput.value.trim(),
          deviceId: deviceInput ? deviceInput.value.trim() : '',
          persona: persona.value,
          replyLength: replyLength.value,
          autoComment: !!(auto && auto.checked),
          vision: !!(vision && vision.checked)
        });
        toast('本地服务配置已保存在浏览器');
      });
    }

    [serverInput, tokenInput, deviceInput].forEach(function (input) {
      if (input) input.addEventListener('input', updateSummary);
    });
    if (persona) persona.addEventListener('change', updateSummary);
    if (serverInput && !serverInput.value) serverInput.value = 'http://127.0.0.1:8787';
    updateSummary();
    showStep(1);

    var requestedStep = Number(new URLSearchParams(window.location.search).get('step'));
    if (requestedStep >= 1 && requestedStep <= 3) showStep(requestedStep);

    var saved = safeStore('smDemoConfig');
    if (saved) {
      if (saved.serverUrl && serverInput) serverInput.value = saved.serverUrl;
      if (saved.appToken && tokenInput) tokenInput.value = saved.appToken;
      if (saved.deviceId && deviceInput) deviceInput.value = saved.deviceId;
      if (saved.persona && persona) persona.value = saved.persona;
      if (saved.replyLength && replyLength) replyLength.value = saved.replyLength;
      if (auto) auto.checked = !!saved.autoComment;
      if (vision) vision.checked = saved.vision !== false;
      updateSummary();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initDownload();
    initDemo();
    initSetup();
  });
})();
