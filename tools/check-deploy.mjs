/*
 * Does the deployed site's download button actually reach the ZIP?
 *
 * Every other check in this session was a curl: status codes, sizes, hashes,
 * a screenshot. None of those involve the browser running site/app.js. The
 * button's whole job is a HEAD probe followed by swapping the dialog body, and
 * a wrong path, a wrong method, or a CORS problem leaves the page looking fine
 * while every visitor silently gets the fallback help dialog instead of the
 * extension. So this drives a real Chrome against the deployed origin.
 *
 * Read-only and free: no API key, no model call. The extension is not loaded —
 * this tests the website, not the plugin.
 *
 * 11 checks: the four pages render, the download literal exists, its HEAD probe
 * answers, the button offers the ZIP, the two working files are not served, and
 * unknown paths return a real 404 with the 404 page.
 *
 *   node tools/check-deploy.mjs
 *   node tools/check-deploy.mjs --url https://example.pages.dev
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const BASE = (urlIndex >= 0 && args[urlIndex + 1]
  ? args[urlIndex + 1]
  : 'https://shangtou-meowmeow.pages.dev').replace(/\/+$/, '');

const CDP_PORT = 9433;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  for (const candidate of [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Minimal CDP client — one socket, one page target. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate threw');
    }
    return result.result.value;
  }
}

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((target) => target.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        return new Cdp(ws);
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('could not attach to Chrome');
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('[deploy] no Chrome/Edge binary found; set CHROME_PATH');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'sm-deploy-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${join(profile, 'profile')}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let failed = false;
try {
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  // ---- 1. the four pages load, with styles and scripts applied ----
  //
  // "Has an <h1>" is not enough to call a page rendered: the 404 page has one
  // too, so a broken route that served 404.html instead of its own page would
  // pass. Each path is therefore also required to show its own title.
  const pages = [
    { path: '/', title: '喵喵陪你刷' },
    { path: '/demo', title: '在线试玩' },
    { path: '/install', title: '安装说明' },
    { path: '/setup', title: '开通 API' },
  ];
  for (const page of pages) {
    await cdp.send('Page.navigate', { url: BASE + page.path });
    await sleep(1200);
    const state = await cdp.eval(`(() => ({
      title: document.title,
      styled: getComputedStyle(document.body).backgroundColor,
      scripts: [...document.scripts].length,
      h1: (document.querySelector('h1') || {}).textContent || '',
      broken: [...document.images].filter((img) => img.complete && img.naturalWidth === 0).length,
    }))()`);
    const rightPage = state.title.includes(page.title) && !state.title.includes('这里没有这一页');
    check(
      page.path + ' renders its own page',
      rightPage && state.h1.trim().length > 0 && state.broken === 0,
      'title=' + JSON.stringify(state.title) + ' brokenImages=' + state.broken
    );
  }

  // ---- 2. the download button does its probe and offers the real file ----
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);

  // Read the URL out of the *deployed* app.js rather than restating it here.
  // A hardcoded name would only prove that this file agrees with itself; the
  // interesting question is whether the page the visitor gets points at a ZIP
  // that is actually there.
  const deployedUrl = await cdp.eval(`(async () => {
    const source = await (await fetch('${BASE}/app.js')).text();
    const match = source.match(/var DOWNLOAD_URL\\s*=\\s*'([^']+)'/);
    return match ? match[1] : null;
  })()`);
  check('deployed app.js declares a download URL', Boolean(deployedUrl), deployedUrl || 'literal not found');

  const probe = await cdp.eval(`(async () => {
    const res = await fetch(new URL(${JSON.stringify(deployedUrl || 'missing.zip')}, '${BASE}/'), {
      method: 'HEAD',
      cache: 'no-store',
    });
    return { status: res.status, type: res.headers.get('content-type'), length: res.headers.get('content-length') };
  })()`);
  check(
    'the URL the page points at answers its own HEAD probe',
    probe.status === 200 && /zip/.test(probe.type || ''),
    'status=' + probe.status + ' type=' + probe.type + ' bytes=' + probe.length
  );

  // Click the real button and read what the dialog ended up saying. The happy
  // path puts the ZIP href in the body; the fallback path shows help text.
  const dialog = await cdp.eval(`(async () => {
    const button = [...document.querySelectorAll('a,button')]
      .find((el) => /下载|获取插件|安装包/.test(el.textContent || ''));
    if (!button) return { found: false };
    button.click();
    await new Promise((r) => setTimeout(r, 2500));
    const open = document.querySelector('[role="dialog"], .modal, dialog[open]');
    return {
      found: true,
      open: Boolean(open),
      hasZipLink: Boolean(document.querySelector('a[href$=".zip"]')),
      text: (open ? open.textContent : document.body.textContent || '').slice(0, 240),
    };
  })()`);
  check(
    'download button opens a dialog pointing at the ZIP',
    dialog.found && dialog.open && dialog.hasZipLink,
    dialog.found ? 'open=' + dialog.open + ' zipLink=' + dialog.hasZipLink : 'button not found'
  );

  // ---- 3. internal working files are not served ----
  // Both files are staged out, so these must not resolve to real content. The
  // body is checked as well as the status: an HTML 404 is fine, a 404 that
  // still contains the deployment notes would not be.
  for (const path of ['/README.md', '/serve.mjs']) {
    const result = await cdp.eval(`(async () => {
      const res = await fetch('${BASE}${path}', { cache: 'no-store' });
      return { status: res.status, body: (await res.text()).slice(0, 4000) };
    })()`);
    const leaked = /Cloudflare Pages|node serve\.mjs|发布到|BYOK 流程/.test(result.body);
    check(
      path + ' is not served',
      result.status === 404 && !leaked,
      'status=' + result.status + (leaked ? ' body contains internal deployment notes' : '')
    );
  }

  // ---- 4. unknown paths are real 404s, not 200s that happen to render ----
  // Cloudflare Pages serves index.html with HTTP 200 for every unmatched path
  // unless a top-level 404.html exists ("SPA fallback"). That made /typo and
  // /admin indistinguishable from real pages to crawlers and link checkers,
  // and is invisible from the browser. Assert both halves: the status AND that
  // the body is the 404 page rather than the homepage.
  for (const path of ['/no-such-page-xyz', '/admin']) {
    const result = await cdp.eval(`(async () => {
      const res = await fetch('${BASE}${path}', { cache: 'no-store' });
      return { status: res.status, body: (await res.text()).slice(0, 4000) };
    })()`);
    const isNotFoundPage = /这一页/.test(result.body) && !/刷一会儿/.test(result.body);
    check(
      path + ' answers 404 with the 404 page',
      result.status === 404 && isNotFoundPage,
      'status=' + result.status + (isNotFoundPage ? '' : ' body is the homepage (soft 404)')
    );
  }
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
}

const passed = results.filter((r) => r.ok).length;
console.log('\n[deploy] ' + passed + '/' + results.length + ' checks passed · ' + BASE);
if (passed !== results.length) failed = true;
process.exit(failed ? 1 : 0);
