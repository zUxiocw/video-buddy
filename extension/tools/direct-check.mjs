#!/usr/bin/env node
/**
 * End-to-end check for direct (BYOK) mode.
 *
 * Loads the real unpacked extension into headless Chrome and points it at a
 * local stub that speaks the OpenAI chat-completions dialect. Nothing here
 * talks to DeepSeek, so the run costs no tokens and needs no key — which is
 * also why it can be run on every change instead of once.
 *
 * What this proves that unit tests cannot:
 *   - the service worker actually loads with its importScripts() chain intact
 *     (a packaging/ordering mistake leaves it dead, and no unit test sees that)
 *   - the optional host permission path really reaches a non-https origin
 *   - a streamed reply arrives as deltas and ends with exactly one 喵
 *   - every failure shape surfaces as a readable error instead of a hang
 *
 * Usage: node extension/tools/direct-check.mjs [--keep]
 */
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(HERE, '..');

const PORT = 8801;
const CDP_PORT = 9334;
const MODEL_OK = 'sk-local-stub-key';

/* ------------------------------- the stub ------------------------------- */

// Records what the worker actually sent, so the assertions below can talk
// about the request rather than only the reply.
const seen = [];
let mode = 'ok';

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function analyzeReply() {
  return {
    summary: '猫把桌上的杯子推了下去',
    keywords: ['猫', '拆家'],
    mood: '嫌弃',
    isAd: false,
    isLive: false,
    risk: 'ok',
    reaction: '这猫是故意的吧，看你一眼再推',
    memeUsed: null,
    confidence: 0.8,
  };
}

const stub = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;

  if (!request.url.endsWith('/chat/completions')) {
    json(response, 404, { error: { message: 'not found' } });
    return;
  }

  const auth = request.headers.authorization || '';
  const body = (() => {
    try { return JSON.parse(raw); } catch { return null; }
  })();
  seen.push({ auth, body });

  if (mode === 'auth') {
    json(response, 401, { error: { message: 'invalid api key' } });
    return;
  }
  if (mode === 'server-error') {
    json(response, 500, { error: { message: 'upstream exploded' } });
    return;
  }
  if (mode === 'not-json') {
    // A 200 whose content is prose, not JSON: the analyze path must reject it
    // rather than treat the whole sentence as a summary.
    json(response, 200, {
      choices: [{ message: { content: '喵觉得这条视频还行' } }],
    });
    return;
  }

  if (!body || body.stream !== true) {
    json(response, 200, {
      choices: [{ message: { content: JSON.stringify(analyzeReply()) } }],
    });
    return;
  }

  // Streamed chat. Split the text into several deltas so the SSE parser and
  // the 喵 filter both get exercised mid-string rather than on one blob.
  const pieces = ['这猫', '推杯子的', '手法', '太熟练了', '，绝对是惯犯'];
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const piece of pieces) {
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  response.write('data: [DONE]\n\n');
  response.end();
});

await new Promise((resolve) => stub.listen(PORT, '127.0.0.1', resolve));

/* ------------------------------ fake page ------------------------------- */

const HARNESS = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>假抖音</title>
<style>body{margin:0;background:#111;color:#fff;height:100vh;overflow:hidden}
.stage{position:relative;height:100vh;display:grid;place-items:center}
video{width:min(360px,60vw);height:min(640px,80vh);background:#222;border-radius:10px}
.desc{position:absolute;left:12%;bottom:18%;max-width:300px;font-size:14px}
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
  }, 80);
  const video = document.getElementById('v');
  video.srcObject = canvas.captureStream(12);
  video.play().catch(() => {});
</script></body></html>`;

const site = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(HARNESS);
});
const SITE_PORT = 8802;
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));

/* ------------------------------ CDP client ------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('[direct] no Chrome/Edge binary found; set CHROME_PATH');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'sm-direct-'));
const extCopy = join(profile, 'ext');
cpSync(EXT_ROOT, extCopy, {
  recursive: true,
  filter: (source) => !/[\\/](tools|dist|node_modules)[\\/]/.test(source),
});

// Point the extension at the stub. The content script has to run on the fake
// page too, and the emotion icons must be web-accessible there or they 404.
const manifestPath = join(extCopy, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const script of manifest.content_scripts) script.matches.push(`http://127.0.0.1:${SITE_PORT}/*`);
manifest.host_permissions.push(`http://127.0.0.1:${SITE_PORT}/*`);
manifest.web_accessible_resources[0].matches.push(`http://127.0.0.1:${SITE_PORT}/*`);
// The stub origin has to be grantable. It is loopback over plain http, which
// normalizeApiBaseUrl accepts and the shipped manifest already covers for
// server mode — this line only exists because the harness uses its own ports.
manifest.optional_host_permissions = [`http://127.0.0.1:${PORT}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

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

function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function evaluate(sessionId, expression) {
  const result = await browser.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function openExtensionPage() {
  const target = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  const sessionId = (await browser.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })).sessionId;
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(sessionId, `!!chrome.storage && document.body.dataset.ready === '1'`)) return sessionId;
    await sleep(100);
  }
  throw new Error('extension page never became ready');
}

/** Save settings from an extension page, where chrome.storage is reachable. */
async function saveSettings(sessionId, patch) {
  return evaluate(
    sessionId,
    `(async () => {
      const stored = await new Promise((r) => chrome.storage.local.get('settings', r));
      const next = Object.assign({}, stored.settings || {}, ${JSON.stringify(patch)});
      await new Promise((r) => chrome.storage.local.set({ settings: next }, r));
      return next;
    })()`,
  );
}

async function sendRuntimeMessage(sessionId, message) {
  return evaluate(
    sessionId,
    `new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => {
       resolve(chrome.runtime.lastError ? { __error: chrome.runtime.lastError.message } : r);
     }))`,
  );
}

const directSettings = {
  mode: 'direct',
  apiKey: MODEL_OK,
  apiBaseUrl: `http://127.0.0.1:${PORT}`,
  enabled: true,
};

try {
  let version = null;
  for (let i = 0; i < 80 && !version; i += 1) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome debug endpoint never came up');
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  browser = new Cdp(ws);

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
  if (!extensionId) throw new Error('service worker never started — importScripts() chain is broken?');
  console.log(`[direct] extension ${extensionId}, browser ${version.Browser}`);

  // A dead worker would mean a missing shared module, which is exactly the
  // packaging failure this check exists to catch early.
  check('service worker loads with its importScripts() chain', !!extensionId);

  const ext = await openExtensionPage();
  const normalized = await saveSettings(ext, directSettings);
  check('settings keep direct mode', normalized.mode === 'direct', JSON.stringify(normalized.mode));
  check('loopback base URL survives normalization', normalized.apiBaseUrl === `http://127.0.0.1:${PORT}`, normalized.apiBaseUrl);

  // Loopback needs no prompt: host_permissions already lists http://127.0.0.1/*
  // (patterns ignore the port), so pointing direct mode at a local stub works
  // out of the box. That is what makes this mode testable without a key.
  const loopbackGranted = await evaluate(
    ext,
    `new Promise((r) => chrome.permissions.contains({ origins: ['http://127.0.0.1:${PORT}/*'] }, (ok) => r(ok)))`,
  );
  check('loopback origin is already granted by host_permissions', loopbackGranted === true, String(loopbackGranted));

  // A remote endpoint is the case that needs a prompt, and chrome.permissions
  // .request() only accepts a live user gesture — which cannot exist here. What
  // can be pinned down is that the request lives in popup.js, not the worker:
  // a gesture does not survive the sendMessage hop, so moving it back silently
  // breaks every prompt. (Verified red earlier against the worker-routed code.)
  // Strip comments before searching: background.js explains this decision in
  // prose, and a naive substring test matched its own explanation.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const popupSource = code(readFileSync(join(extCopy, 'popup', 'popup.js'), 'utf8'));
  const workerSource = code(readFileSync(join(extCopy, 'background.js'), 'utf8'));
  check(
    'permission prompt is requested from the popup, not the service worker',
    popupSource.includes('chrome.permissions.request') && !workerSource.includes('chrome.permissions.request'),
  );
  const noGesture = await evaluate(
    ext,
    `new Promise((r) => chrome.permissions.request({ origins: ['https://example.invalid/*'] }, (ok) => {
       r({ ok, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
     }))`,
  );
  check(
    'without a gesture Chrome refuses the prompt (why the popup owns it)',
    noGesture && noGesture.ok !== true,
    JSON.stringify(noGesture),
  );

  /* --- analyze --- */
  seen.length = 0;
  mode = 'ok';
  const analyzed = await sendRuntimeMessage(ext, {
    type: 'sm:analyze',
    payload: {
      requestId: 'direct-analyze-1',
      app: 'douyin',
      tone: 'maomao',
      dwellMs: 10000,
      ocr: { text: '', caption: '猫主子又开始拆家了', hashtags: ['萌宠'] },
      images: [],
      recentReactions: [],
      adLabel: false,
      repeat: false,
      videoBucket: 'short',
    },
  });
  check('analyze succeeds', analyzed && analyzed.ok === true, JSON.stringify(analyzed && analyzed.error));
  check(
    'reaction carries exactly one 喵',
    typeof analyzed?.data?.reaction === 'string' &&
      analyzed.data.reaction.endsWith('喵') &&
      !analyzed.data.reaction.slice(0, -1).includes('喵'),
    analyzed?.data?.reaction,
  );
  check('analyze request used the user key as a bearer token', seen[0]?.auth === `Bearer ${MODEL_OK}`, seen[0]?.auth);
  check('analyze request is non-streaming JSON mode', seen[0]?.body?.stream === false && seen[0]?.body?.response_format?.type === 'json_object');
  check('analyze sends the shared persona prompt', JSON.stringify(seen[0]?.body?.messages || []).includes('你是用户手机里的'));

  /* --- ad confirmation --- */
  seen.length = 0;
  const adAnalyzed = await sendRuntimeMessage(ext, {
    type: 'sm:analyze',
    payload: {
      requestId: 'direct-analyze-ad',
      app: 'douyin',
      tone: 'maomao',
      dwellMs: 10000,
      ocr: { text: '', caption: '这个真的太好用了 #好物', hashtags: [] },
      images: [],
      recentReactions: [],
      adLabel: true,
      repeat: false,
      videoBucket: 'short',
    },
  });
  check('page ad chip forces the ad verdict', adAnalyzed?.data?.isAd === true, JSON.stringify(adAnalyzed?.data?.isAd));
  check('ad reaction is the canned one', /过分|气人/.test(adAnalyzed?.data?.reaction || ''), adAnalyzed?.data?.reaction);

  /* --- chat streaming --- */
  seen.length = 0;
  const chat = await evaluate(
    ext,
    `new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'sm-net' });
      const deltas = [];
      let done = null;
      const timer = setTimeout(() => { try { port.disconnect(); } catch {} resolve({ deltas, done, timedOut: true }); }, 20000);
      port.onMessage.addListener((message) => {
        if (message.type === 'delta') deltas.push(message.text);
        if (message.type === 'error') { clearTimeout(timer); resolve({ deltas, error: message.error }); }
        if (message.type === 'done') { done = message; clearTimeout(timer); resolve({ deltas, done }); }
      });
      port.postMessage({
        type: 'chat',
        payload: {
          requestId: 'direct-chat-1',
          sessionId: 'sess-direct',
          tone: 'maomao',
          message: '笑死我了',
          context: {},
          history: [],
          emotionTally: {},
        },
      });
    })`,
  );
  const streamed = (chat.deltas || []).join('');
  check('chat streams more than one delta', (chat.deltas || []).length > 1, JSON.stringify(chat.deltas));
  check('streamed reply ends with exactly one 喵', streamed.endsWith('喵') && !streamed.slice(0, -1).includes('喵'), streamed);
  check('done frame carries a server-side emotion', typeof chat.done?.emotion === 'string', JSON.stringify(chat.done));
  // Chat and analyze use different system prompts, so the marker differs.
  check('chat request is streaming with the shared prompt', seen[0]?.body?.stream === true && JSON.stringify(seen[0]?.body?.messages || []).includes('陪用户刷抖音、随便聊天'));

  /* --- failure shapes --- */
  mode = 'auth';
  const unauthorized = await sendRuntimeMessage(ext, {
    type: 'sm:analyze',
    payload: { requestId: 'x1', app: 'douyin', tone: 'maomao', dwellMs: 1000, ocr: { text: '', caption: '', hashtags: [] }, images: [], recentReactions: [], adLabel: false, repeat: false },
  });
  check('401 becomes UPSTREAM_AUTH and is not retryable', unauthorized?.error?.code === 'UPSTREAM_AUTH' && unauthorized?.error?.retryable === false, JSON.stringify(unauthorized?.error));

  mode = 'server-error';
  const serverError = await sendRuntimeMessage(ext, {
    type: 'sm:analyze',
    payload: { requestId: 'x2', app: 'douyin', tone: 'maomao', dwellMs: 1000, ocr: { text: '', caption: '', hashtags: [] }, images: [], recentReactions: [], adLabel: false, repeat: false },
  });
  check('5xx becomes a retryable UPSTREAM_ERROR', serverError?.error?.code === 'UPSTREAM_ERROR' && serverError?.error?.retryable === true, JSON.stringify(serverError?.error));

  mode = 'not-json';
  const garbled = await sendRuntimeMessage(ext, {
    type: 'sm:analyze',
    payload: { requestId: 'x3', app: 'douyin', tone: 'maomao', dwellMs: 1000, ocr: { text: '', caption: '', hashtags: [] }, images: [], recentReactions: [], adLabel: false, repeat: false },
  });
  check('prose instead of JSON is a protocol error, not a summary', garbled?.error?.code === 'UPSTREAM_PROTOCOL', JSON.stringify(garbled?.error));

  /* --- missing key --- */
  await saveSettings(ext, { apiKey: '' });
  const noKey = await sendRuntimeMessage(ext, {
    type: 'sm:analyze',
    payload: { requestId: 'x4', app: 'douyin', tone: 'maomao', dwellMs: 1000, ocr: { text: '', caption: '', hashtags: [] }, images: [], recentReactions: [], adLabel: false, repeat: false },
  });
  check('missing key fails fast with NO_API_KEY', noKey?.error?.code === 'NO_API_KEY', JSON.stringify(noKey?.error));
} catch (error) {
  failures += 1;
  console.error('[direct] FAILED: ' + (error && error.stack ? error.stack : error));
} finally {
  try { await browser?.send('Browser.close'); } catch { /* already gone */ }
  // Chrome keeps handles on the profile briefly after close; deleting too
  // early throws EPERM on Windows and would mask the real result.
  await Promise.race([
    new Promise((resolve) => chrome.once('exit', resolve)),
    sleep(5000),
  ]);
  chrome.kill();
  stub.close();
  site.close();
  if (keep) console.log(`[direct] kept profile at ${profile}`);
  else {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch { await sleep(400); }
    }
  }
  console.log(failures === 0 ? '[direct] all checks passed' : `[direct] ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
