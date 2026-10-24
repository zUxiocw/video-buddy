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
import { deflateRawSync } from 'node:zlib';

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

/* ---------- minimal zip writer (no dependencies) ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store uncompressed when deflate does not help (already-compressed PNGs).
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, end]);
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
