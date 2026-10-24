#!/usr/bin/env node
/**
 * Stage a deployable copy of site/ into site-dist/.
 *
 * The same reason pack-extension.mjs is an allowlist: site/ is the working
 * directory, and it holds things that must not be served — README.md documents
 * the internal decisions (why Firefox is unsupported, why the store is not
 * used), serve.mjs is a local preview server. Exclusions fail open: one
 * forgotten pattern and an internal note is on the public web.
 *
 * The second job is the download button. site/app.js probes
 * `download/<name>.zip` and falls back to a help dialog when it is missing, so
 * a build that forgets the ZIP produces a site that looks fine and quietly
 * never offers the extension. That is checked here, not left to a human.
 *
 *   node tools/pack-site.mjs
 *   node tools/pack-site.mjs --out _publish
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE_ROOT = join(REPO_ROOT, 'site');

/* ---------- allowlist ---------- */

// Pages and their two shared files. A new page has to be added here; that is
// deliberate, so nothing lands on the web just by existing in site/.
const PAGES = ['index.html', 'demo.html', 'install.html', 'setup.html'];
const SHARED = ['styles.css', 'app.js'];
// Copied whole. PNGs only — anything else in assets/ is not referenced.
const ASSET_DIRS = ['assets'];

function walk(dir, prefix) {
  const files = [];
  for (const entry of readdirSync(join(SITE_ROOT, dir), { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...walk(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.png')) files.push(rel);
  }
  return files;
}

function stageList() {
  const files = [...PAGES, ...SHARED];
  for (const dir of ASSET_DIRS) files.push(...walk(dir, dir));
  // The ZIP is written by pack-extension.mjs and is gitignored, so it exists
  // only on a machine that ran it. Found rather than named, so a version bump
  // does not need a second edit here.
  const downloadDir = join(SITE_ROOT, 'download');
  const zips = existsSync(downloadDir)
    ? readdirSync(downloadDir).filter((name) => name.endsWith('.zip'))
    : [];
  for (const zip of zips) files.push('download/' + zip);
  return { files, zips };
}

/* ---------- guards ---------- */

function refuse(message) {
  console.error('[site] REFUSED: ' + message);
  process.exit(1);
}

/** Everything the pages reference by relative path must exist in the output. */
function assertReferencesResolve(staged) {
  const present = new Set(staged);
  for (const page of PAGES) {
    const html = readFileSync(join(SITE_ROOT, page), 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
      const ref = match[1];
      // Only same-directory references; mailto:, https:, #anchors are skipped
      // by the pattern above, and a query string is not used on this site.
      if (!present.has(ref)) refuse(page + ' references a file that is not staged: ' + ref);
    }
  }
}

/**
 * The download button and the ZIP on disk must agree on the version.
 *
 * `DOWNLOAD_URL` is a literal in app.js that mirrors the packer's output name.
 * Bumping manifest.json without it leaves a permanent 404 behind the button —
 * the probe falls back to the help dialog, so nothing looks broken, and the
 * extension simply cannot be downloaded.
 */
function assertDownloadMatches(staged, zips) {
  const source = readFileSync(join(SITE_ROOT, 'app.js'), 'utf8');
  const match = source.match(/var DOWNLOAD_URL\s*=\s*'([^']+)'/);
  if (!match) refuse('site/app.js has no DOWNLOAD_URL literal to check');
  const url = match[1];
  if (!zips.length) {
    refuse(
      'no ZIP in site/download/, so the download button would never offer the extension.\n' +
      '         Run: node extension/tools/pack-extension.mjs --out site/download'
    );
  }
  if (!staged.includes(url)) {
    refuse(
      'site/app.js points at ' + url + ' but the only ZIP is ' + zips.join(', ') + '.\n' +
      '         The version in manifest.json changed; update DOWNLOAD_URL in site/app.js.'
    );
  }
}

/** Internal documents and dev-only files must not reach the output. */
function assertNothingInternal(staged) {
  const FORBIDDEN = ['README.md', 'serve.mjs', '.gitkeep'];
  for (const name of staged) {
    const base = name.split('/').pop();
    if (FORBIDDEN.includes(base)) refuse('staged an internal file: ' + name);
    if (base.startsWith('.env') || base.endsWith('.pem')) refuse('staged a secret: ' + name);
  }
}

/* ---------- main ---------- */

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 && args[outIndex + 1]
  ? resolve(args[outIndex + 1])
  : join(REPO_ROOT, 'site-dist');

const { files, zips } = stageList();
const staged = files
  .map((name) => name.replaceAll('\\', '/'))
  .sort();

assertNothingInternal(staged);
assertReferencesResolve(staged);
assertDownloadMatches(staged, zips);

// Clear a previous build, but only one that looks like ours: a stray --out
// pointing at a real directory should stop, not delete it.
if (existsSync(outDir)) {
  const entries = readdirSync(outDir);
  if (entries.length && !entries.includes('index.html')) {
    refuse('refusing to clear ' + relative(REPO_ROOT, outDir) + ': it is not empty and has no index.html');
  }
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

let bytes = 0;
for (const name of staged) {
  const target = join(outDir, name);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SITE_ROOT, name), target);
  bytes += statSync(target).size;
}

// Make the omission visible rather than silent: whoever runs this should be
// able to see at a glance that the dev files were held back on purpose.
const skipped = readdirSync(SITE_ROOT).filter(
  (name) => !['assets', 'download'].includes(name) && !staged.some((file) => file === name)
);

console.log('[site] ' + staged.length + ' files, ' + (bytes / 1024).toFixed(0) + ' KiB → ' + relative(REPO_ROOT, outDir));
for (const name of staged) console.log('       ' + name);
if (skipped.length) console.log('[site] held back (working files, not published): ' + skipped.join(', '));
console.log('[site] deploy the CONTENTS of ' + relative(REPO_ROOT, outDir) + '/, not the folder itself');
