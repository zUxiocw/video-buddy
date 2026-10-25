(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

  var EMOTIONS = {
    greet: {
      label: '打招呼',
      img: 'assets/emotions/greet-128.png',
      line: '来了？位置给你留着呢，坐喵。',
      color: '#b9d7ff'
    },
    happy: {
      label: '开心',
      img: 'assets/emotions/happy-128.png',
      line: '这波给你点个赞，今天眼光在线喵。',
      color: '#ffe6a8'
    },
    annoyed: {
      label: '嫌弃',
      img: 'assets/emotions/annoyed-128.png',
      line: '就这也能让你停十秒，品味真稳定喵。',
      color: '#d9c8ff'
    },
    angry: {
      label: '生气',
      img: 'assets/emotions/angry-128.png',
      line: '广告都骑脸了，你还能忍，我都替你气喵。',
      color: '#ffb7a5'
    },
    laugh: {
      label: '大笑',
      img: 'assets/emotions/laugh-128.png',
      line: '这猫一本正经地拆家，我实在绷不住喵。',
      color: '#ffd9e4'
    },
    excited: {
      label: '兴奋',
      img: 'assets/emotions/excited-128.png',
      line: '这个有点东西，快往下刷，别停喵。',
      color: '#b9f5d1'
    },
    sad: {
      label: '委屈',
      img: 'assets/emotions/sad-128.png',
      line: '你都没看我一眼，我眼泪都要掉了喵。',
      color: '#b9d7ff'
    },
    confused: {
      label: '疑惑',
      img: 'assets/emotions/confused-128.png',
      line: '等等，刚才那一下是不是剪掉了喵？',
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

  // The real extension uses fixed 5-minute / 5-second intervals. The demo
  // compresses the first wait so it can be tried without sitting through five
  // minutes, but keeps the every-5-seconds rhythm and the pause/resume rule.
  var NUDGE_LINES = [
    '喂，这么久没理我了喵。',
    '视频比我好看是吧喵？',
    '你再不回，我就一直说喵。',
    '看我一眼，就一眼喵。',
    '行，你刷，我就在这儿念喵。'
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

  // Built by `node extension/tools/pack-extension.mjs --out site/download`. The
  // name mirrors the packer's output, and the ZIP itself is gitignored: it is a
  // build artefact, so it must exist in the deployed folder rather than the repo.
  var DOWNLOAD_URL = 'download/shangtou-miaomiao-v0.1.1.zip';

  /**
   * Ask the static host whether the package is actually there before offering
   * it. A bare link that 404s looks like a broken site; a dialog that opens
   * with the steps to build it is at least actionable. Deployments that ship
   * the ZIP get the real download, and nothing has to be kept in sync by hand.
   */
  function downloadReady(callback) {
    if (!window.fetch) {
      callback(false);
      return;
    }
    fetch(DOWNLOAD_URL, { method: 'HEAD', cache: 'no-store' }).then(function (response) {
      callback(response.ok);
    }).catch(function () {
      callback(false);
    });
  }

  function downloadBody(ready) {
    if (ready) {
      return (
        '<h2>下载扩展安装包</h2>' +
        '<p>这是一个 zip。解压到一个固定目录，然后到 <code>chrome://extensions</code> 打开「开发者模式」，点「加载已解压的扩展程序」选它。装好后在扩展设置里填自己的 DeepSeek API Key。</p>' +
        '<div class="dialog-actions">' +
          '<button class="btn btn-ghost" type="button" data-dialog-close>关闭</button>' +
          '<a class="btn btn-primary" href="' + DOWNLOAD_URL + '" download>下载 zip</a>' +
        '</div>' +
        '<p class="micro" style="margin-top:12px">包内没有服务器代码，也没有任何密钥：只包含扩展运行需要的脚本、图标和设置页。</p>'
      );
    }
    return (
      '<h2>安装包暂时拿不到</h2>' +
      '<p>公开版走 BYOK：装扩展，在设置里填你自己的 DeepSeek API Key，不需要本地服务器。可以先试玩 Demo，或照着开通步骤走一遍；安装说明里有手动加载扩展的完整步骤。</p>' +
      '<div class="dialog-actions">' +
        '<button class="btn btn-ghost" type="button" data-dialog-close>关闭</button>' +
        '<a class="btn btn-primary" href="setup.html">看开通步骤</a>' +
      '</div>'
    );
  }

  function downloadDialog() {
    var dialog = $('#downloadDialog');
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.className = 'preview-dialog';
    dialog.id = 'downloadDialog';
    dialog.setAttribute('aria-label', '安装说明');
    document.body.appendChild(dialog);

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
      if (event.target.closest('[data-dialog-close]')) dialog.close();
    });
    return dialog;
  }

  /**
   * Probe first, then open, so the body never swaps under the reader's cursor.
   * The probe is a same-origin HEAD against a static file, so it resolves in a
   * few milliseconds; a cached body would keep claiming "not published" after
   * the ZIP was deployed, which is the more annoying failure.
   */
  function openDownloadDialog() {
    downloadReady(function (ready) {
      var dialog = downloadDialog();
      var pad = document.createElement('div');
      pad.className = 'dialog-pad';
      pad.innerHTML = downloadBody(ready);
      dialog.textContent = '';
      dialog.appendChild(pad);
      dialog.showModal();
    });
  }

  function initDownload() {
    $$('[data-download]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        openDownloadDialog();
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
    var silenceStatus = $('#silenceStatus');
    var silenceClock = $('#silenceClock');
    var silenceClockNote = $('#silenceClockNote');
    var silenceNote = $('#silenceNote');
    var startSilenceButton = $('#startSilence');
    var stopSilenceButton = $('#stopSilence');
    var budgetButton = $('#showBudget');
    var nudgeCountEl = $('#nudgeCount');
    var nudgeDots = $('#nudgeDots');
    var NUDGE_DEMO_LIMIT = 10;
    var nudgeTimer = 0;
    var nudgeActive = false;
    var nudgeIndex = 0;
    var nudgeCount = 0;

    var ballPos = { x: 0, y: 0 };
    var dragStart = null;
    var ballMoved = false;
    var pointerActivated = false;

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

    function setSilenceUi(state) {
      if (!silenceStatus) return;
      var clockWrap = silenceClock ? silenceClock.parentElement : null;
      if (clockWrap) clockWrap.classList.toggle('is-nagging', state === 'nagging');
      if (state === 'nagging') {
        silenceStatus.className = 'demo-status is-nagging';
        silenceStatus.textContent = '沉默计时 · 催你中 · 视频停留计时暂停';
        if (silenceClock) silenceClock.textContent = '5s';
        if (silenceClockNote) silenceClockNote.textContent = '加速演示 · 真实每 5 秒一次';
        if (silenceNote) silenceNote.textContent = '正在催：每 5 秒一句，直到你主动回话。视频停留计时从触发时冻结。';
        if (startSilenceButton) {
          startSilenceButton.hidden = true;
          startSilenceButton.textContent = '模拟沉默没说话';
        }
        if (stopSilenceButton) stopSilenceButton.hidden = false;
        return;
      }
      if (state === 'locked') {
        silenceStatus.className = 'demo-status is-locked';
        silenceStatus.textContent = '已催满 10 次 · 正式版关页进入冷静期';
        if (silenceClock) silenceClock.textContent = '10:00';
        if (silenceClockNote) silenceClockNote.textContent = '冷静期示意';
        if (silenceNote) silenceNote.textContent = '这里只演示计数，不会真的关页；正式版会关页并在冷静期内拒绝再打开。';
        if (startSilenceButton) {
          startSilenceButton.hidden = false;
          startSilenceButton.textContent = '再模拟一次';
        }
        if (stopSilenceButton) stopSilenceButton.hidden = true;
        return;
      }
      if (state === 'stopped') {
        silenceStatus.className = 'demo-status';
        silenceStatus.textContent = '已恢复 · 视频停留计时继续';
        if (silenceClock) silenceClock.textContent = '00:00';
        if (silenceClockNote) silenceClockNote.textContent = '你回话了';
        if (silenceNote) silenceNote.textContent = '你主动回话后，视频停留计时从暂停处继续，不会把刚才催你的几秒算进去。';
        if (startSilenceButton) {
          startSilenceButton.hidden = false;
          startSilenceButton.textContent = '再模拟一次';
        }
        if (stopSilenceButton) stopSilenceButton.hidden = true;
        return;
      }
      silenceStatus.className = 'demo-status demo-status-quiet';
      silenceStatus.textContent = '沉默计时 · 未触发';
      if (silenceClock) silenceClock.textContent = '05:00';
      if (silenceClockNote) silenceClockNote.textContent = '距下一次催促';
      if (silenceNote) silenceNote.textContent = '真实值：默认沉默 5 分钟（可调 1–10 分钟），之后每 5 秒一次；催满次数默认 10，可调 3–60。这里把等待加速成 2 秒，方便试玩。';
      if (startSilenceButton) {
        startSilenceButton.hidden = false;
        startSilenceButton.textContent = '模拟沉默没说话';
      }
      if (stopSilenceButton) stopSilenceButton.hidden = true;
    }

    function setNudgeCount(count) {
      nudgeCount = Math.max(0, count);
      if (nudgeCountEl) nudgeCountEl.textContent = String(nudgeCount);
      if (nudgeDots) {
        var dots = nudgeDots.querySelectorAll('i');
        for (var i = 0; i < dots.length; i += 1) {
          dots[i].classList.toggle('on', i < nudgeCount);
        }
        nudgeDots.classList.toggle('is-full', nudgeCount >= NUDGE_DEMO_LIMIT);
      }
    }

    function stopSilence() {
      if (!nudgeActive) return;
      nudgeActive = false;
      clearTimeout(nudgeTimer);
      nudgeTimer = 0;
      setNudgeCount(0);
      setSilenceUi('stopped');
    }

    function startSilence() {
      if (nudgeActive) return;
      nudgeActive = true;
      nudgeIndex = 0;
      setNudgeCount(0);
      openPanel();
      setEmotion('annoyed');
      setSilenceUi('nagging');
      // One compressed wait, then the fixed 5-second rhythm. The pause rule
      // is represented by the status text and the counter freezing here.
      function nudge() {
        if (!nudgeActive) return;
        setNudgeCount(nudgeCount + 1);
        if (nudgeCount >= NUDGE_DEMO_LIMIT) {
          nudgeActive = false;
          clearTimeout(nudgeTimer);
          nudgeTimer = 0;
          var closeLine = '催满十次了，正式版这里就关页冷静喵。';
          addMessage('assistant', closeLine, 'angry');
          showBubble(closeLine, 6000);
          setEmotion('angry');
          setSilenceUi('locked');
          return;
        }
        var line = NUDGE_LINES[nudgeIndex % NUDGE_LINES.length];
        nudgeIndex += 1;
        addMessage('assistant', line, 'annoyed');
        showBubble(line, 1500);
        setEmotion('annoyed');
        if (silenceClock) silenceClock.textContent = '5s';
        nudgeTimer = setTimeout(nudge, 1200);
      }
      nudgeTimer = setTimeout(nudge, 2000);
    }

    function resetSilence() {
      nudgeActive = false;
      clearTimeout(nudgeTimer);
      nudgeTimer = 0;
      nudgeIndex = 0;
      setNudgeCount(0);
      setSilenceUi('idle');
    }

    function showBudgetNotice() {
      openPanel();
      setEmotion('annoyed');
      var line = '今天给自己设了 30 分钟，到点我关页喵。';
      addMessage('assistant', line, 'annoyed');
      showBubble(line, 7000);
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
      if (nudgeActive) stopSilence();
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

    if (budgetButton) budgetButton.addEventListener('click', showBudgetNotice);
    if (startSilenceButton) startSilenceButton.addEventListener('click', startSilence);
    if (stopSilenceButton) {
      stopSilenceButton.addEventListener('click', function () {
        if (!nudgeActive) return;
        addMessage('user', '在呢，别催了');
        stopSilence();
        setTimeout(function () {
          var line = '行，计时恢复，继续刷你的喵。';
          addMessage('assistant', line, 'annoyed');
          showBubble(line, 4000);
        }, 500);
      });
    }

    var reset = $('#resetDemo');
    if (reset) {
      reset.addEventListener('click', function () {
        resetSilence();
        messages.innerHTML = '';
        addMessage('assistant', '来了？先刷你的，我看看今天又能刷到什么离谱东西喵。', 'greet');
        setEmotion('greet');
        if (bubble) bubble.classList.remove('on');
        toast('对话已重置');
      });
    }

    setSilenceUi('idle');
    addMessage('assistant', '来了？先刷你的，我看看今天又能刷到什么离谱东西喵。', 'greet');
    showVideo(0, false);
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

  function initLimitDemo() {
    var browser = $('#desktopLimit');
    if (!browser) return;

    var tab = $('#desktopLimitTab');
    var line = $('#desktopLimitLine');
    var countdown = $('#desktopLimitCountdown');
    var closedNote = $('#desktopClosedNote');
    var reopen = $('#desktopLimitReopen');
    var reset = $('#desktopLimitReset');
    var start = $('#startLimitDemo');
    var stop = $('#stopLimitDemo');
    var budgetLabel = $('#demoLimitBudget');
    var usedLabel = $('#demoLimitUsed');
    var fill = $('#demoLimitFill');
    var timers = [];
    var interval = 0;
    var budgetMinutes = 30;
    var state = 'open';

    function clock(totalSeconds) {
      var safe = Math.max(0, Math.round(totalSeconds));
      return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
    }

    function syncBudget() {
      if (budgetLabel) budgetLabel.textContent = clock(budgetMinutes * 60);
      if (usedLabel) usedLabel.textContent = clock(budgetMinutes * 60 * 0.79);
      if (fill) fill.style.width = '79%';
      $$('[data-demo-limit]').forEach(function (button) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.demoLimit) === budgetMinutes));
      });
    }

    function clearTimers() {
      window.clearInterval(interval);
      interval = 0;
      timers.forEach(function (id) { window.clearTimeout(id); });
      timers = [];
    }

    function setState(next) {
      state = next;
      browser.dataset.state = next;
      if (tab) tab.hidden = next === 'closed';
      if (start) start.disabled = next !== 'open';
      if (stop) stop.hidden = next === 'open';
    }

    function resetDemo(announce) {
      clearTimers();
      setState('open');
      if (announce !== false) {
        toast('桌面标签页已恢复，可以重新试玩');
        if (start) start.focus({ preventScroll: true });
      }
    }

    function showClosed(kind) {
      clearTimers();
      setState('closed');
      if (closedNote) {
        closedNote.textContent = kind === 'back'
          ? '冷却还没结束。再打开，它还会关。'
          : '冷却 10 分钟内再打开，它会说一句再关一次。';
      }
      window.setTimeout(function () {
        if (reopen) reopen.focus({ preventScroll: true });
      }, 40);
    }

    function showWarning(kind) {
      clearTimers();
      var panel = $('#chatPanel');
      if (panel && panel.classList.contains('on')) {
        var close = $('#chatClose');
        if (close) close.click();
      }
      setState('warn');
      var isBack = kind === 'back';
      var seconds = isBack ? 2 : 5;
      var suffix = isBack ? ' 秒后继续关页' : ' 秒后关闭这个标签页';
      var left = seconds;
      if (line) line.textContent = isBack ? '还敢点开，不给你刷了喵' : '差不多了哦，本喵要下班了喵';
      if (countdown) countdown.textContent = left + suffix;
      var rect = browser.getBoundingClientRect();
      if (rect.top < 8 || rect.bottom > window.innerHeight - 8) {
        var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        browser.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      }
      interval = window.setInterval(function () {
        left -= 1;
        if (left > 0 && countdown) countdown.textContent = left + suffix;
      }, 1000);
      timers.push(window.setTimeout(function () { showClosed(kind); }, seconds * 1000));
    }

    $$('[data-demo-limit]').forEach(function (button) {
      button.addEventListener('click', function () {
        budgetMinutes = Number(button.dataset.demoLimit) || 30;
        syncBudget();
      });
    });
    if (start) start.addEventListener('click', function () { showWarning('over'); });
    if (stop) stop.addEventListener('click', function () { resetDemo(true); });
    if (reopen) reopen.addEventListener('click', function () { showWarning('back'); });
    if (reset) reset.addEventListener('click', function () { resetDemo(true); });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state !== 'open') resetDemo(true);
    });

    syncBudget();
  }

  function initSetup() {
    var card = $('.setup-card');
    if (!card) return;

    var steps = $$('.step-panel');
    var tabs = $$('.step-rail button');
    var current = 1;

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
        var value = block ? block.innerText : '';
        if (!value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function () {
            toast('启动命令已复制');
          }).catch(function () {
            toast('复制失败，请手动选择命令');
          });
        } else {
          toast('复制失败，请手动选择命令');
        }
      });
    }

    var requestedStep = Number(new URLSearchParams(window.location.search).get('step'));
    if (requestedStep >= 1 && requestedStep <= 3) showStep(requestedStep);
    else showStep(1);
  }

  document.addEventListener('DOMContentLoaded', function () {
    initDownload();
    initDemo();
    initLimitDemo();
    initSetup();
  });
})();
