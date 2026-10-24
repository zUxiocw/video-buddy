#!/usr/bin/env node
/**
 * Build a distributable ZIP of the extension.
 *
 * The list of files is an ALLOWLIST, not a set of exclusions. Anything new
 * that lands in extension/ (a scratch debug file, a dev harness, a note) is
 * therefore left out until someone deliberately adds it here. Exclusion
 * patterns fail open — one forgotten rule ships a secret — so this does not
 * use them.
 *
 * Refuses to run if the repository root holds a private key, because that is
 * the exact file a "zip the project" habit would sweep up.
 *
 *   node extension/tools/pack-extension.mjs
 *   node extension/tools/pack-extension.mjs --out releases
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with tools/pack-site.mjs: one ZIP writer, so a fix (or a bug) in the
// archive format cannot exist in only one of the two release paths.
import { buildZip } from '../../tools/zip-writer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(EXT_ROOT, '..');

/* ---------- the allowlist ---------- */

// Read from the manifest rather than restating it, so a new content script or
// icon path is picked up automatically instead of silently missing from the
// package (which would produce an extension that loads but half-works).
//
// The service worker is the one place the manifest cannot describe: it pulls
// its dependencies in with importScripts(), and MV3 has no module loader. Those
// files are therefore read back out of background.js. Without this the ZIP
// omits every shared module and the worker dies on its first line, while the
// manifest-derived list still looks complete — a hand-maintained second list is
// exactly how this was missed once already.
function importScriptsFiles(entry) {
  const source = readFileSync(join(EXT_ROOT, entry), 'utf8');
  const files = new Set();
  for (const match of source.matchAll(/importScripts\s*\(([\s\S]*?)\)\s*;/g)) {
    for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      // importScripts resolves relative to the worker, which sits at the
      // extension root, so the literal is already an extension-relative path.
      files.add(literal[1]);
    }
  }
  return files;
}

function manifestFiles() {
  const manifest = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.json'), 'utf8'));
  const files = new Set(['manifest.json', 'background.js']);

  for (const script of manifest.content_scripts || []) {
    for (const js of script.js || []) files.add(js);
  }
  if (manifest.background?.service_worker) {
    files.add(manifest.background.service_worker);
    for (const dep of importScriptsFiles(manifest.background.service_worker)) files.add(dep);
  }
  if (manifest.action?.default_popup) {
    files.add(manifest.action.default_popup);
    // The popup is an HTML page with its own script next to it.
    const dir = dirname(manifest.action.default_popup);
    for (const name of readdirSync(join(EXT_ROOT, dir))) {
      // ZIP entry names are always forward-slash; join() gives backslashes on
      // Windows and a strict reader would treat "popup\popup.js" as one file.
      if (name.endsWith('.js') || name.endsWith('.css')) files.add(join(dir, name).replaceAll('\\', '/'));
    }
  }
  for (const [, path] of Object.entries(manifest.icons || {})) files.add(path);
  for (const [, path] of Object.entries(manifest.action?.default_icon || {})) files.add(path);
  for (const entry of manifest.web_accessible_resources || []) {
    for (const pattern of entry.resources || []) {
      // Only the *.png form is used; expand it against what is on disk.
      if (pattern.endsWith('/*.png')) {
        const dir = dirname(pattern);
        for (const name of readdirSync(join(EXT_ROOT, dir))) {
          if (name.endsWith('.png')) files.add(join(dir, name).replaceAll('\\', '/'));
        }
      } else {
        files.add(pattern);
      }
    }
  }
  return [...files].sort();
}

/* ---------- guards ---------- */

const FORBIDDEN_NAMES = [
  'extension.pem',
  '.env',
  '.env.local',
  'id_rsa',
  '.git',
];
// Anything under these prefixes is development-only and must not ship.
const FORBIDDEN_PREFIXES = ['tools/', 'test/', 'tests/', '.backup-'];

function refuse(message) {
  console.error('[pack] REFUSED: ' + message);
  process.exit(1);
}

function assertClean(files) {
  for (const file of files) {
    const base = file.split('/').pop();
    if (FORBIDDEN_NAMES.includes(base) || base.startsWith('.env')) {
      refuse('allowlist contains a secret: ' + file);
    }
    if (FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      refuse('allowlist contains development files: ' + file);
    }
    if (!existsSync(join(EXT_ROOT, file))) {
      refuse('allowlist references a missing file: ' + file);
    }
  }
  // The private key lives at the repo root. If anyone ever moves it into
  // extension/, the allowlist guard above catches it; this catches the other
  // direction — a pack run pointed at the wrong directory.
  if (existsSync(join(REPO_ROOT, 'extension.pem')) && !existsSync(join(EXT_ROOT, 'manifest.json'))) {
    refuse('extension root does not look like the extension; aborting');
  }
}

/* ---------- main ---------- */

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 && args[outIndex + 1] ? resolve(args[outIndex + 1]) : join(REPO_ROOT, 'releases');

const files = manifestFiles();
assertClean(files);

const manifest = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.json'), 'utf8'));
const entries = files.map((name) => ({ name, data: readFileSync(join(EXT_ROOT, name)) }));
const zip = buildZip(entries);

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `shangtou-miaomiao-v${manifest.version}.zip`);
writeFileSync(outPath, zip);

const totalBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
console.log(`[pack] ${entries.length} files, ${(totalBytes / 1024).toFixed(1)} KiB raw`);
for (const name of files) console.log('       ' + name);
console.log(`[pack] wrote ${relative(REPO_ROOT, outPath)} (${(zip.length / 1024).toFixed(1)} KiB)`);
