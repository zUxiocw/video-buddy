// End-to-end check: loads the unpacked extension into headless Chrome against a
// fake Douyin page, waits out the dwell threshold, and inspects the shadow DOM.
//
// Requires the buddy server to be running (npm run dev in server/).
// Usage: node tools/e2e.mjs [--keep]
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, '..');
const require = createRequire(import.meta.url);
// Same mapping the content script uses, so expected moods are not hand-copied.
const Emotions = require(join(extRoot, 'shared', 'emotions.js'));
const stripMaoTail = (text) => String(text == null ? '' : text)
  .replace(/喵+[。，,、！!？?~～\s]*$/, '')
  .trim();

// Chrome 155's --headless=new silently ignores --load-extension, so Edge is
// listed first; a headed Chrome works too. Set CHROME_PATH to override.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => {
  try {
    return require('node:fs').existsSync(candidate);
  } catch {
    return false;
  }
});
if (!chromePath) {
  console.error('[e2e] no Chrome/Edge binary found; set CHROME_PATH');
  process.exit(2);
}

const envToken = process.env.APP_TOKEN || readServerToken();
const PORT = 8799;
const CDP_PORT = 9333;

function readServerToken() {
  try {
    const text = readFileSync(join(extRoot, '..', 'server', '.env'), 'utf8');
    const match = /^APP_TOKEN=(.+)$/m.exec(text);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

const HARNESS = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>假抖音</title>
<style>
  body{margin:0;background:#111;color:#fff;font-family:sans-serif;height:100vh;overflow:hidden}
  .stage{position:relative;height:100vh;display:grid;place-items:center}
  video{width:min(360px,60vw);height:min(640px,80vh);background:#222;border-radius:10px;object-fit:cover}
  .desc{position:absolute;left:12%;bottom:18%;max-width:300px;font-size:14px;line-height:1.5}
</style></head>
<body><div class="stage"><video id="v" autoplay muted playsinline></video>
<div class="desc" data-e2e="video-desc">猫主子又开始拆家了 #萌宠 #猫猫</div></div>
<script>
  const canvas = document.createElement('canvas');
  canvas.width = 540; canvas.height = 960;
  const ctx = canvas.getContext('2d');
  let t = 0;
  setInterval(() => {
    t += 1;
    ctx.fillStyle = 'hsl(' + (t % 360) + ',60%,25%)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#eee';
    ctx.font = '48px sans-serif';
    ctx.fillText('视频播放中', 120, 480);
  }, 80);
  const video = document.getElementById('v');
  video.srcObject = canvas.captureStream(12);
  video.play().catch(() => {});

  // Stand-in for Douyin's document shortcuts: typing a space in the chat box
  // must not reach these.
  window.__pageEvents = [];
  function logEvent(event) { window.__pageEvents.push(event.type + ':' + (event.key || '')); }
  // Capture phase is the hard case: a bubble-only test passes even when the
  // page's document-level capture shortcuts still fire.
  window.addEventListener('keydown', logEvent, true);
  window.addEventListener('keyup', logEvent, true);
  document.addEventListener('keydown', logEvent, true);
  document.addEventListener('keyup', logEvent, true);
  document.addEventListener('wheel', logEvent, { passive: true });
</script></body></html>`;

/* ------------------------------ CDP client ------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(sessionId, _unused, expression) {
  const result = await browser.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text + ' ' + JSON.stringify(result.exceptionDetails.exception?.description || ''));
  }
  return result.result.value;
}

/* --------------------------------- main --------------------------------- */

const profile = mkdtempSync(join(tmpdir(), 'sm-e2e-'));
const extCopy = join(profile, 'ext');
cpSync(extRoot, extCopy, {
  recursive: true,
  filter: (source) => !/[\\/](tools|dist|node_modules)[\\/]/.test(source),
});
const manifestPath = join(extCopy, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const script of manifest.content_scripts) script.matches.push(`http://127.0.0.1:${PORT}/*`);
manifest.host_permissions.push(`http://127.0.0.1:${PORT}/*`);
// Emotion icons are web-accessible only to Douyin in the shipped manifest, so
// the harness origin needs the same grant or every icon 404s.
manifest.web_accessible_resources[0].matches.push(`http://127.0.0.1:${PORT}/*`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(HARNESS);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${join(profile, 'profile')}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--disable-extensions-except=${extCopy}`,
    `--load-extension=${extCopy}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
chrome.stderr.on('data', () => {});

const keep = process.argv.includes('--keep');
let browser;
let failures = 0;
let extensionId = '';
let lastPopupTarget = '';

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

try {
  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Chrome debug endpoint never came up');
  browser = await connect(version.webSocketDebuggerUrl);

  // Find our service worker among every extension the profile ships with.
  for (let i = 0; i < 60 && !extensionId; i += 1) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const worker = targetInfos.find(
      (target) =>
        target.type === 'service_worker' &&
        target.url.startsWith('chrome-extension://') &&
        /\/background\.js$/.test(target.url),
    );
    if (worker) extensionId = new URL(worker.url).host;
    else await sleep(250);
  }
  if (!extensionId) throw new Error('extension service worker not found (did the extension load?)');
  console.log(`[e2e] extension ${extensionId}, browser ${version.Browser}`);

  // Configure the extension through its own popup page.
  const popup = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  lastPopupTarget = popup.targetId;
  const popupSession = (await browser.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await browser.send('Runtime.enable', {}, popupSession);
  const popupReady = await poll(
    () => evaluate(
      popupSession,
      undefined,
      `location.protocol === 'chrome-extension:' && !!chrome.storage && !!chrome.storage.local && document.body.dataset.ready === '1'`,
    ),
    (value) => value === true,
    10000,
  );
  check('extension popup exposes chrome.storage', popupReady);
  if (!popupReady) throw new Error('popup did not load');
  const settings = {
    enabled: true,
    serverUrl: 'http://127.0.0.1:8787',
    appToken: envToken,
    deviceId: 'e2e-device-0001',
    dwellSeconds: 4,
    cooldownSeconds: 0,
    autoOpenPanel: false,
    bubbleSeconds: 6,
    emotionHoldSeconds: 4,
  };
  await evaluate(
    popupSession,
    undefined,
    `new Promise((resolve) => chrome.storage.local.set({settings: ${JSON.stringify(settings)}}, resolve))`,
  );
  const storedSettings = await evaluate(
    popupSession,
    undefined,
    `new Promise((resolve) => chrome.storage.local.get('settings', (d) => resolve(d.settings)))`,
  );
  check('settings persisted', storedSettings && storedSettings.appToken === envToken, JSON.stringify(storedSettings && storedSettings.appToken ? 'token ok' : storedSettings));
  const ping = await evaluate(
    popupSession,
    undefined,
    `new Promise((resolve) => chrome.runtime.sendMessage({type:'sm:ping'}, resolve))`,
  );
  check('server reachable from extension', !!(ping && ping.ok), JSON.stringify(ping));
  await browser.send('Target.closeTarget', { targetId: lastPopupTarget });

  const page = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/` });
  const pageSession = (await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await browser.send('Runtime.enable', {}, pageSession);

  const hostReady = await poll(
    () => evaluate(pageSession, undefined, `!!document.getElementById('sm-buddy-host')`),
    (value) => value === true,
    8000,
  );
  check('floating ball mounts', hostReady);
  if (!hostReady) throw new Error('content script did not mount');

  const videoReady = await evaluate(
    pageSession,
    undefined,
    `(() => { const v = document.querySelector('video'); return !!v && v.readyState >= 2 && !v.paused; })()`,
  );
  check('harness video is playing', videoReady);

  const ringMoved = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `(() => {
        const host = document.getElementById('sm-buddy-host');
        const ring = host && host.shadowRoot.querySelector('.ring');
        return ring ? Number(ring.style.getPropertyValue('--p')) || 0 : 0;
      })()`,
    ),
    (value) => value > 0.05,
    5000,
  );
  check('progress ring tracks dwell', ringMoved);

  const bubbleText = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `(() => {
        const host = document.getElementById('sm-buddy-host');
        const bubble = host && host.shadowRoot.querySelector('.bubble');
        return bubble && bubble.classList.contains('on') ? bubble.textContent : '';
      })()`,
    ),
    (value) => typeof value === 'string' && value.length > 0,
    20000,
  );
  check('proactive reaction appears', !!bubbleText, String(bubbleText));
  if (bubbleText) console.log(`[e2e] reaction: ${bubbleText}`);
  check('reaction has no exclamation mark', !/[!！]/.test(String(bubbleText || '')));
  check('reaction has no 哈哈/语气词', !/哈哈|呵呵/.test(String(bubbleText || '')));

  // Open the panel by clicking the ball and chat once.
  await evaluate(
    pageSession,
    undefined,
    `(() => {
      const host = document.getElementById('sm-buddy-host');
      const ball = host.shadowRoot.querySelector('.ball');
      ball.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10}));
      ball.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10}));
      return true;
    })()`,
  );
  const panelOpen = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `(() => {
        const host = document.getElementById('sm-buddy-panel-host');
        const panel = host && host.shadowRoot.querySelector('.panel');
        return !!panel && panel.classList.contains('on');
      })()`,
    ),
    (value) => value === true,
    3000,
  );
  check('chat panel opens on click', panelOpen);

  // Typing in the chat box must not leak keys to the page's shortcuts.
  if (panelOpen) {
    await evaluate(
      pageSession,
      undefined,
      `(() => {
        const panel = document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.panel');
        const input = panel.querySelector('.input');
        input.focus();
        input.value = '测 试';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, composed: true }));
        input.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true }));
        input.value = '';
        return true;
      })()`,
    );
    const leak = await evaluate(pageSession, undefined, `window.__pageEvents.slice()`);
    check('typing in chat does not reach page shortcuts', Array.isArray(leak) && leak.length === 0, JSON.stringify(leak));

    // Synthetic events prove propagation, not that the browser still inserts
    // text. Use CDP key events for the real typing path.
    await browser.send('Page.bringToFront', {}, pageSession);
    await evaluate(
      pageSession,
      undefined,
      `(() => {
        const input = document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.input');
        input.value = '';
        input.focus();
        return true;
      })()`,
    );
    const key = (type, keyName, code, text, vk) => browser.send(
      'Input.dispatchKeyEvent',
      {
        type,
        key: keyName,
        code,
        ...(text ? { text, unmodifiedText: text } : {}),
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      },
      pageSession,
    );
    await key('keyDown', 'a', 'KeyA', 'a', 65);
    await key('keyUp', 'a', 'KeyA', '', 65);
    await key('keyDown', ' ', 'Space', ' ', 32);
    await key('keyUp', ' ', 'Space', '', 32);
    const typed = await evaluate(
      pageSession,
      undefined,
      `document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.input').value`,
    );
    check('real typing still reaches the chat input', typed === 'a ', JSON.stringify(typed));
    const realLeak = await evaluate(pageSession, undefined, `window.__pageEvents.slice()`);
    check('real typing does not reach page shortcuts', Array.isArray(realLeak) && realLeak.length === 0, JSON.stringify(realLeak));
  }

  if (panelOpen) {
    await evaluate(
      pageSession,
      undefined,
      `(() => {
        const panel = document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.panel');
        const input = panel.querySelector('.input');
        input.value = '这视频讲了啥';
        panel.querySelector('.send').click();
        return true;
      })()`,
    );
    const reply = await poll(
      () => evaluate(
        pageSession,
        undefined,
        `(() => {
          const host = document.getElementById('sm-buddy-panel-host');
          const panel = host && host.shadowRoot.querySelector('.panel');
          if (!panel) return '';
          const msgs = panel.querySelectorAll('.msg.a');
          const last = msgs[msgs.length - 1];
          return last && !last.classList.contains('caret') ? last.textContent : '';
        })()`,
      ),
      (value) => typeof value === 'string' && value.length > 0,
      15000,
    );
    check('chat stream returns a reply', !!reply, String(reply));
    if (reply) console.log(`[e2e] chat: ${reply}`);

    // Closing the panel must resolve the stream port instead of leaking it.
    await evaluate(
      pageSession,
      undefined,
      `document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('[data-act="close"]').click()`,
    );

    // The panel's hide button is gone: only close (×) remains.
    const hideButtonGone = await evaluate(
      pageSession,
      undefined,
      `!document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('[data-act="hide"]')`,
    );
    check('panel has no hide/delete button', hideButtonGone === true);

    // Drag the ball to a new spot; move up-left so viewport clamping can't
    // hide the movement.
    const dragResult = await evaluate(
      pageSession,
      undefined,
      `(() => {
        const host = document.getElementById('sm-buddy-host');
        const ball = host.shadowRoot.querySelector('.ball');
        const before = host.shadowRoot.querySelector('.wrap').getBoundingClientRect();
        const opts = {bubbles: true, button: 0, pointerId: 7, clientX: before.left + 10, clientY: before.top + 10};
        ball.dispatchEvent(new PointerEvent('pointerdown', opts));
        const moved = {...opts, clientX: opts.clientX - 80, clientY: opts.clientY - 60};
        ball.dispatchEvent(new PointerEvent('pointermove', moved));
        ball.dispatchEvent(new PointerEvent('pointerup', moved));
        const after = host.shadowRoot.querySelector('.wrap').getBoundingClientRect();
        return {dx: Math.round(after.left - before.left), dy: Math.round(after.top - before.top)};
      })()`,
    );
    check('ball can be dragged', dragResult.dx < -20 && dragResult.dy < -20, JSON.stringify(dragResult));

    // Resize by dragging the corner grip, then read the persisted values from
    // an extension page (the page's main world has no chrome.storage).
    const resizeResult = await evaluate(
      pageSession,
      undefined,
      `(() => {
        const host = document.getElementById('sm-buddy-host');
        const grip = host.shadowRoot.querySelector('.grip');
        const ball = host.shadowRoot.querySelector('.ball');
        const before = ball.getBoundingClientRect().width;
        const rect = grip.getBoundingClientRect();
        const opts = {bubbles: true, button: 0, pointerId: 9, clientX: rect.left + 2, clientY: rect.top + 2};
        grip.dispatchEvent(new PointerEvent('pointerdown', opts));
        const moved = {...opts, clientX: opts.clientX + 20, clientY: opts.clientY + 20};
        grip.dispatchEvent(new PointerEvent('pointermove', moved));
        grip.dispatchEvent(new PointerEvent('pointerup', moved));
        return {before, after: ball.getBoundingClientRect().width};
      })()`,
    );
    check('corner grip resizes the ball', resizeResult.after > resizeResult.before, JSON.stringify(resizeResult));

    const readTarget = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
    });
    const readSession = (await browser.send('Target.attachToTarget', { targetId: readTarget.targetId, flatten: true })).sessionId;
    await browser.send('Runtime.enable', {}, readSession);
    const persisted = await poll(
      () => evaluate(
        readSession,
        undefined,
        `new Promise((resolve) => chrome.storage.local.get(['settings', 'smPosition'], (d) => resolve({position: d.smPosition || null, ballSize: d.settings && d.settings.ballSize})))`,
      ),
      (value) => !!value && !!value.position,
      4000,
    );
    check('drag position persisted', !!(persisted && persisted.position), JSON.stringify(persisted));
    check(
      'resized ball size persisted',
      !!(persisted && persisted.ballSize > resizeResult.before),
      JSON.stringify(persisted && persisted.ballSize),
    );
    await browser.send('Target.closeTarget', { targetId: readTarget.targetId });
  }

  // A new video must retrigger and add a second log entry, not go silent.
  const logBefore = await evaluate(
    pageSession,
    undefined,
    `document.getElementById('sm-buddy-panel-host').shadowRoot.querySelectorAll('.msg.a').length`,
  );
  await evaluate(
    pageSession,
    undefined,
    `(async () => {
      const desc = document.querySelector('[data-e2e="video-desc"]');
      desc.textContent = '另一条：狗子学会了开冰箱 #萌宠';
      return desc.textContent;
    })()`,
  );
  const secondReaction = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `(() => {
        const block = document.getElementById('sm-buddy-panel-host').shadowRoot;
        const items = block.querySelectorAll('.msg.a');
        return { count: items.length, last: items.length ? items[items.length - 1].textContent : '' };
      })()`,
    ),
    // Wait for the reaction itself, not just any new assistant message: the
    // previous chat reply may still be finishing when this section starts.
    (value) => value && value.count > Number(logBefore) && /狗子|冰箱/.test(String(value.last)),
    20000,
  );
  check('second video adds a new log entry', !!secondReaction && secondReaction.count > Number(logBefore), JSON.stringify(secondReaction));
  const newLog = await evaluate(
    pageSession,
    undefined,
    `(() => {
      const items = document.getElementById('sm-buddy-panel-host').shadowRoot.querySelectorAll('.msg.a');
      return Array.from(items).map((item) => item.textContent).find((text) => /狗子|冰箱/.test(text)) || '';
    })()`,
  );
  check('new log entry is about the new video', /狗子|冰箱/.test(String(newLog)), String(newLog));

  /* ---------------- task 1: live log + history ---------------- */

  // Reactions must appear in the log even while the panel is closed, and a
  // reopen must show the same entries (not a freshly fabricated one).
  const closedCount = await evaluate(
    pageSession,
    undefined,
    `(() => {
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      const panel = root.querySelector('.panel');
      return { open: panel.classList.contains('on'), entries: root.querySelectorAll('.msg.a').length };
    })()`,
  );
  check('reactions are logged while the panel is closed', closedCount.entries >= 2, JSON.stringify(closedCount));

  const reopened = await evaluate(
    pageSession,
    undefined,
    `(() => {
      const host = document.getElementById('sm-buddy-host');
      const ball = host.shadowRoot.querySelector('.ball');
      ball.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 3, clientX: 10, clientY: 10}));
      ball.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 3, clientX: 10, clientY: 10}));
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      return root.querySelectorAll('.msg.a').length;
    })()`,
  );
  check('reopening the panel keeps every logged entry', reopened >= closedCount.entries, `${closedCount.entries} -> ${reopened}`);

  // A reaction that arrives while the panel is already open must show up live.
  const liveCount = await poll(
    async () => {
      await evaluate(
        pageSession,
        undefined,
        `(() => {
          const desc = document.querySelector('[data-e2e="video-desc"]');
          desc.textContent = '第三条：楼下那只橘猫在晒太阳 #萌宠';
          return desc.textContent;
        })()`,
      );
      return evaluate(
        pageSession,
        undefined,
        `(() => {
          const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
          const items = root.querySelectorAll('.msg.a');
          return { count: items.length, last: items.length ? items[items.length - 1].textContent : '' };
        })()`,
      );
    },
    // Wait for the new video's reaction, not just the next assistant message.
    (value) => value && value.count > Number(reopened) && /橘猫|晒太阳/.test(String(value.last)),
    25000,
  );
  check('open panel updates live when a reaction arrives', !!liveCount && liveCount.count > Number(reopened), JSON.stringify(liveCount));
  check('live entry is about the newest video', /橘猫|晒太阳/.test(String(liveCount.last)), String(liveCount.last));

  // The current conversation must be persisted to smHistory.
  const historyTarget = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  const historySession = (await browser.send('Target.attachToTarget', { targetId: historyTarget.targetId, flatten: true })).sessionId;
  await browser.send('Runtime.enable', {}, historySession);
  const saved = await poll(
    () => evaluate(
      historySession,
      undefined,
      `new Promise((resolve) => chrome.storage.local.get('smHistory', (d) => resolve(d.smHistory || [])))`,
    ),
    (value) => Array.isArray(value) && value.length > 0,
    8000,
  );
  check('current conversation is saved to history', Array.isArray(saved) && saved.length >= 1, JSON.stringify(saved && saved.length));
  const savedText = JSON.stringify(saved || []);
  check('saved history contains the proactive lines', /橘猫|狗子|猫主子/.test(savedText), savedText.slice(0, 120));
  check('saved history has no system seed line', !savedText.includes('悬浮球在这儿'), savedText.slice(0, 120));
  await browser.send('Target.closeTarget', { targetId: historyTarget.targetId });

  // The in-panel history view lists the previous session and can delete it.
  const historyUi = await evaluate(
    pageSession,
    undefined,
    `(() => {
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      root.querySelector('[data-act="history"]').click();
      const panel = root.querySelector('.history');
      return {
        open: panel.classList.contains('on'),
        rows: panel.querySelectorAll('.hrow').length,
        hint: panel.querySelector('.hhint') ? panel.querySelector('.hhint').textContent : '',
      };
    })()`,
  );
  check('history view opens from the panel', historyUi.open === true, JSON.stringify(historyUi));

  // Plant an earlier session, then use the panel to return to it. This is the
  // user-facing "回到上一次对话" path.
  const pastSession = {
    id: 'e2e-past-session-0001',
    startedAt: Date.now() - 3_600_000,
    endedAt: Date.now() - 3_000_000,
    messages: [
      { role: 'user', content: '上一次聊的那只猫呢', at: Date.now() - 3_100_000 },
      { role: 'assistant', content: '上次说到它在沙发上打滚', at: Date.now() - 3_050_000 },
    ],
  };
  const seedHistory = async (sessions) => {
    const target = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
      background: true,
    });
    const sessionId = (await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await browser.send('Runtime.enable', {}, sessionId);
    try {
      await poll(
        () => evaluate(sessionId, undefined, `document.body.dataset.ready === '1'`),
        (value) => value === true,
        8000,
      );
      await evaluate(
        sessionId,
        undefined,
        `(async () => {
          const stored = await new Promise((r) => chrome.storage.local.get('smHistory', r));
          const kept = (stored.smHistory || []).filter(
            (item) => !${JSON.stringify(sessions.map((item) => item.id))}.includes(item.id),
          );
          await new Promise((r) => chrome.storage.local.set(
            { smHistory: ${JSON.stringify(sessions)}.concat(kept) },
            r,
          ));
          return true;
        })()`,
      );
    } finally {
      await browser.send('Target.closeTarget', { targetId: target.targetId });
    }
    await browser.send('Target.activateTarget', { targetId: page.targetId });
  };

  await seedHistory([pastSession]);
  const listed = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `(() => {
        const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
        const rows = Array.from(root.querySelectorAll('.history .hrow'));
        const row = rows.find((item) => /上一次聊的那只猫呢/.test(item.textContent));
        return { rows: rows.length, found: !!row, label: row ? row.textContent : '' };
      })()`,
    ),
    (value) => value && value.found === true,
    8000,
  );
  check('history lists the earlier session', !!listed && listed.found === true, JSON.stringify(listed));

  const restored = await evaluate(
    pageSession,
    undefined,
    `(() => {
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      const rows = Array.from(root.querySelectorAll('.history .hrow'));
      const row = rows.find((item) => /上一次聊的那只猫呢/.test(item.textContent));
      if (!row) return { clicked: false };
      row.querySelector('button').click();
      return {
        clicked: true,
        historyOpen: root.querySelector('.history').classList.contains('on'),
        log: root.querySelector('.msgs') ? root.querySelector('.msgs').textContent : '',
      };
    })()`,
  );
  check(
    'history entry can be reopened in the panel',
    restored.clicked &&
      restored.historyOpen === false &&
      /上一次聊的那只猫呢/.test(restored.log) &&
      /上次说到它在沙发上打滚/.test(restored.log),
    JSON.stringify(restored).slice(0, 200),
  );

  // Delete path: a second planted session goes away without touching the log.
  await seedHistory([{ ...pastSession, id: 'e2e-past-session-0002', messages: [
    { role: 'user', content: '要做删除测试的那条', at: Date.now() - 2000 },
    { role: 'assistant', content: '删掉我试试', at: Date.now() - 1000 },
  ] }]);
  const deleted = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `(() => {
        const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
        root.querySelector('[data-act="history"]').click();
        const rows = Array.from(root.querySelectorAll('.history .hrow'));
        const row = rows.find((item) => /要做删除测试的那条/.test(item.textContent));
        const logBefore = root.querySelectorAll('.msg.a').length;
        if (!row) return { skipped: true, logBefore, rows: rows.length };
        row.querySelector('button.del').click();
        return {
          skipped: false,
          logBefore,
          rowsAfter: root.querySelectorAll('.hrow').length,
          stillListed: /要做删除测试的那条/.test(root.querySelector('.history').textContent),
        };
      })()`,
    ),
    (value) => value && value.skipped === false,
    8000,
  );
  check(
    'history entry can be deleted without losing the live log',
    deleted && deleted.skipped === false && deleted.stillListed === false && Number(deleted.logBefore) > 0,
    JSON.stringify(deleted),
  );

  const closedHistory = await evaluate(
    pageSession,
    undefined,
    `(() => {
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      root.querySelector('[data-act="history-close"]').click();
      const history = root.querySelector('.history');
      const log = root.querySelectorAll('.msg.a').length;
      return { historyOpen: history.classList.contains('on'), log };
    })()`,
  );
  check('closing history returns to the live conversation', closedHistory.historyOpen === false && Number(closedHistory.log) > 0, JSON.stringify(closedHistory));

  /* ---------------- task 2: configurable durations ---------------- */

  // Write settings from the popup tab opened at boot. Do NOT open a new tab
  // here: creating one activates it, which hides the harness page and makes
  // Chrome throttle its timers — the dwell loop, bubble hide and emotion swap
  // then never run, which looks like a product bug but is a test artifact.
  // Write settings through a backgrounded extension page. `chrome` is not
  // visible to main-world CDP evaluation (the content script lives in an
  // isolated world), and a foreground popup tab would hide the harness page
  // and let Chrome throttle its timers — the dwell loop, bubble hide and mood
  // reset would stall, which looks like a product bug but is a test artifact.
  const setSettings = async (patch) => {
    const target = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
      background: true,
    });
    const sessionId = (await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await browser.send('Runtime.enable', {}, sessionId);
    try {
      await poll(
        () => evaluate(sessionId, undefined, `document.body.dataset.ready === '1'`),
        (value) => value === true,
        8000,
      );
      await evaluate(
        sessionId,
        undefined,
        `(async () => {
          const stored = await new Promise((r) => chrome.storage.local.get('settings', r));
          const next = Object.assign({}, stored.settings, ${JSON.stringify(patch)});
          await new Promise((r) => chrome.storage.local.set({ settings: next }, r));
          return next;
        })()`,
      );
    } finally {
      await browser.send('Target.closeTarget', { targetId: target.targetId });
    }
    await browser.send('Target.activateTarget', { targetId: page.targetId });
    await sleep(400);
  };
  const swapCaption = (caption) => evaluate(
    pageSession,
    undefined,
    `(async () => {
      const desc = document.querySelector('[data-e2e="video-desc"]');
      desc.textContent = ${JSON.stringify(caption)};
      return desc.textContent;
    })()`,
  );
  const bubbleOn = () => evaluate(
    pageSession,
    undefined,
    `(() => {
      const bubble = document.getElementById('sm-buddy-host').shadowRoot.querySelector('.bubble');
      return !!(bubble && bubble.classList.contains('on'));
    })()`,
  );
  const emotionSrc = () => evaluate(
    pageSession,
    undefined,
    `(() => {
      const host = document.getElementById('sm-buddy-host').shadowRoot;
      const img = host.querySelector('.emotion-icon');
      const ball = host.querySelector('.ball');
      return {
        src: img ? (img.getAttribute('src') || '') : '',
        label: ball ? (ball.getAttribute('aria-label') || '') : '',
      };
    })()`,
  );
  const moodIs = (mood) => (value) => {
    const text = String((value && (value.src + ' ' + value.label)) || '');
    return value !== undefined && value !== null && new RegExp(mood).test(text);
  };
  // Bubble on/off transitions recorded inside the page. Polling from CDP adds
  // latency and can also straddle two reactions, so the page is the better
  // clock for "how long was it on screen".
  const bubbleTrace = () => evaluate(
    pageSession,
    undefined,
    `(window.__trace || []).filter((item) => item.what === 'bubble')`,
  );
  const lastBubbleSpan = async () => {
    const trace = (await bubbleTrace()) || [];
    for (let i = trace.length - 1; i >= 0; i -= 1) {
      if (trace[i].on === false) {
        for (let j = i - 1; j >= 0; j -= 1) {
          if (trace[j].on === true) return trace[i].t - trace[j].t;
        }
      }
    }
    return -1;
  };

  // Record bubble/icon transitions inside the page, so throttling or CDP
  // latency in the test cannot be mistaken for a product timing bug.
  await evaluate(
    pageSession,
    undefined,
    `(() => {
      const host = document.getElementById('sm-buddy-host').shadowRoot;
      const bubble = host.querySelector('.bubble');
      const img = host.querySelector('.emotion-icon');
      window.__trace = [];
      window.__traceStart = performance.now();
      let bubbleOn = bubble.classList.contains('on');
      new MutationObserver(() => {
        const now = bubble.classList.contains('on');
        if (now !== bubbleOn) {
          bubbleOn = now;
          window.__trace.push({ what: 'bubble', on: now, t: Math.round(performance.now() - window.__traceStart) });
        }
      }).observe(bubble, { attributes: true, attributeFilter: ['class'] });
      // Sample the icon instead of observing one node: the <img> is recreated
      // when the page wipes our DOM, and an observer on the old node goes deaf.
      let lastSrc = null;
      setInterval(() => {
        const node = document.getElementById('sm-buddy-host');
        const live = node && node.shadowRoot.querySelector('.emotion-icon');
        const src = live ? live.getAttribute('src') || '' : '';
        if (src && src !== lastSrc) {
          lastSrc = src;
          window.__trace.push({ what: 'icon', src, t: Math.round(performance.now() - window.__traceStart) });
        }
      }, 100);
      return { hasBubble: !!bubble, hasIcon: !!img, vis: document.visibilityState };
    })()`,
  );

  await setSettings({ bubbleSeconds: 4, emotionHoldSeconds: 3 });

  const traceCount = async () => ((await bubbleTrace()) || []).length;
  /** Wait for a full on→off bubble cycle that starts at or after `from`. */
  const waitBubbleCycle = async (from, timeoutMs) => {
    const trace = await poll(
      async () => ({ items: (await bubbleTrace()) || [] }),
      (value) => lastCycleAfter(value.items, from) !== null,
      timeoutMs,
    );
    return lastCycleAfter((trace && trace.items) || [], from);
  };

  // Bubble lifetime: short setting first, then long, measured in-page.
  let mark = await traceCount();
  await swapCaption('第四条：灶台边煮着的泡面 #美食');
  const shortCycle = await waitBubbleCycle(mark, 30000);
  check('bubble appears after a reaction', !!shortCycle);
  const shortMs = shortCycle ? shortCycle.off - shortCycle.on : -1;
  check('bubble hides after the configured 4s', shortMs >= 3000 && shortMs <= 7000, `${shortMs}ms`);

  await setSettings({ bubbleSeconds: 10 });
  mark = await traceCount();
  await swapCaption('第五条：公园里的遛狗大爷 #萌宠');
  const longCycle = await waitBubbleCycle(mark, 35000);
  check('bubble reappears for the next segment', !!longCycle);
  const longMs = longCycle ? longCycle.off - longCycle.on : -1;
  check(
    'longer bubble setting keeps it visible longer',
    longMs >= 8000 && longMs > shortMs + 3000,
    `4s→${shortMs}ms, 10s→${longMs}ms`,
  );

  // Icon hold: a chat message with an emotion word drives a deterministic mood
  // change, independent of what the model replied.
  const sendChat = (text) => evaluate(
    pageSession,
    undefined,
    `(() => {
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      const panel = root.querySelector('.panel');
      if (!panel.classList.contains('on')) {
        const ball = document.getElementById('sm-buddy-host').shadowRoot.querySelector('.ball');
        ball.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 5, clientX: 10, clientY: 10}));
        ball.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 5, clientX: 10, clientY: 10}));
      }
      const input = root.querySelector('.input');
      input.value = ${JSON.stringify(text)};
      root.querySelector('.send').click();
      return true;
    })()`,
  );

  // Moooods are model-chosen, so a single reply may legitimately repeat the
  // one already showing. Send two messages the server colours differently and
  // require the pair to produce at least one icon change.
  // Wait for the stream to finish: the reply node drops its `caret` class on
  // done, and only then does the reply's mood reach the icon.
  const chatState = () => evaluate(
    pageSession,
    undefined,
    `(() => {
      const root = document.getElementById('sm-buddy-panel-host').shadowRoot;
      const items = root.querySelectorAll('.msg.a');
      const last = items.length ? items[items.length - 1] : null;
      return {
        count: items.length,
        streaming: !!(last && last.classList.contains('caret')),
        reply: last ? last.textContent : '',
      };
    })()`,
  );
  const chatMood = async (text) => {
    const before = (await chatState()).count;
    await sendChat(text);
    const done = await poll(chatState, (value) => value && value.count > before && !value.streaming, 30000);
    await sleep(500);
    const mood = await emotionSrc();
    return {
      text,
      reply: String((done && done.reply) || ''),
      icon: String(mood.src || '').replace(/^.*\//, '').replace(/-128\.png$/, ''),
    };
  };

  // Client rule: the reply's own emotion words win; otherwise the server's
  // done.emotion hint is used. pickChatColor maps these messages to a fixed
  // mood, so the expected icon is known even when the reply is bland.
  const HINT_BY_MESSAGE = { 笑死我了: 'laugh', 气死我了: 'angry', 天哪不会吧: 'shocked' };
  const moodSamples = [];
  for (const text of Object.keys(HINT_BY_MESSAGE)) {
    moodSamples.push(await chatMood(text));
  }
  const iconTrace = await evaluate(pageSession, undefined, `(window.__trace || []).filter((i) => i.what === 'icon').slice(-8)`);
  // The icon must match the reply's own emotion when it has one, else the
  // server hint for that message. Anything else means the mood pipeline broke.
  const expectedIcon = (sample) => (Emotions.detect(stripMaoTail(sample.reply)) || {}).id || HINT_BY_MESSAGE[sample.text];
  const moodChecks = moodSamples.map((sample) => ({ ...sample, expected: expectedIcon(sample) }));
  check(
    'chat replies drive the mood icon',
    moodChecks.every((sample) => sample.expected && sample.icon === sample.expected),
    `${JSON.stringify(moodChecks)} trace=${JSON.stringify(iconTrace)}`,
  );

  // Leave a non-default mood on screen so the expiry below is observable.
  for (const text of ['笑死我了', '气死我了', '天哪不会吧']) {
    if (!moodIs('greet')(await emotionSrc())) break;
    await chatMood(text);
  }
  const holdStart = await emotionSrc();
  check('panel keeps a non-default mood open for the hold', !moodIs('greet')(holdStart), JSON.stringify(holdStart));

  // Close the panel: only then may the hold timer actually expire. The hold is
  // 3s, so a revert inside ~7s means the configured duration was respected;
  // anything near the 16s timeout means the reset never ran.
  await evaluate(
    pageSession,
    undefined,
    `document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('[data-act="close"]').click()`,
  );
  const revertStart = Date.now();
  const reverted = await poll(async () => {
    const value = await emotionSrc();
    return { value, elapsed: Date.now() - revertStart };
  }, (value) => moodIs('greet')(value && value.value), 16000);
  const revertMs = Number(reverted && reverted.elapsed);
  check(
    'icon returns to default within the configured hold after closing',
    moodIs('greet')(reverted && reverted.value) && revertMs <= 7000,
    `revert after ${revertMs}ms, ${JSON.stringify(reverted && reverted.value)}`,
  );

  // hold = 0 means "keep the mood until the next change".
  await setSettings({ emotionHoldSeconds: 0 });
  await sleep(600);
  for (const text of ['笑死我了', '气死我了', '天哪不会吧']) {
    if (!moodIs('greet')(await emotionSrc())) break;
    await chatMood(text);
  }
  await evaluate(
    pageSession,
    undefined,
    `document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('[data-act="close"]').click()`,
  );
  // Whatever the reply set is fine; with hold = 0 nothing may reset it.
  await sleep(1200);
  const beforeIdle = await emotionSrc();
  await sleep(8000);
  const afterIdle = await emotionSrc();
  check(
    'hold = 0 keeps the icon instead of resetting',
    beforeIdle.src !== '' && beforeIdle.src === afterIdle.src,
    `${JSON.stringify(beforeIdle)} -> ${JSON.stringify(afterIdle)}`,
  );

  // Enter is intercepted by the document_start guard, so this also proves the
  // guard received buddy.js's handler across the two content-script entries.
  await evaluate(
    pageSession,
    undefined,
    `(() => {
      const panel = document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.panel');
      if (!panel.classList.contains('on')) {
        const ball = document.getElementById('sm-buddy-host').shadowRoot.querySelector('.ball');
        ball.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 11, clientX: 10, clientY: 10}));
        ball.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 11, clientX: 10, clientY: 10}));
      }
      const input = document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.input');
      input.value = 'enter-check';
      input.focus();
      return true;
    })()`,
  );
  await browser.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    pageSession,
  );
  await browser.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    pageSession,
  );
  const enterCleared = await poll(
    () => evaluate(
      pageSession,
      undefined,
      `document.getElementById('sm-buddy-panel-host').shadowRoot.querySelector('.input').value === ''`,
    ),
    (value) => value === true,
    5000,
  );
  check('Enter sends from the chat input', enterCleared);
} catch (error) {
  failures += 1;
  console.error('[e2e] error:', error && error.message);
} finally {
  try {
    if (browser) await browser.send('Browser.close');
  } catch {
    /* ignore */
  }
  chrome.kill();
  server.close();
  if (!keep) {
    await sleep(400);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows may hold files briefly */
    }
  } else {
    console.log(`[e2e] kept profile at ${profile}`);
  }
}

console.log(failures === 0 ? '[e2e] all checks passed' : `[e2e] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/** Last complete on→off bubble cycle starting at index >= from. */
function lastCycleAfter(items, from) {
  const start = Math.max(0, Number(from) || 0);
  for (let i = items.length - 2; i >= start; i -= 1) {
    if (items[i].on === true && items[i + 1].on === false) {
      return { on: items[i].t, off: items[i + 1].t };
    }
  }
  return null;
}

async function poll(fn, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch {
      /* page may be navigating */
    }
    await sleep(200);
  }
  return last;
}
