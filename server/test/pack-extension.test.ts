/*
 * The release ZIP must contain every file the extension loads at runtime.
 *
 * The packer builds its allowlist from manifest.json, which describes content
 * scripts, the popup and icons — but says nothing about the modules the service
 * worker pulls in with importScripts(). MV3 has no module loader, so those
 * files are invisible to the manifest.
 *
 * This happened: after the prompts and guards moved into extension/shared/,
 * background.js began importing five files that manifest.json never mentions,
 * and the packaged ZIP silently shipped without all five. The manifest-derived
 * list still looked complete. Loading that ZIP gives a service worker that dies
 * on its first line.
 *
 * So the assertion is deliberately about the ZIP bytes, not about the packer's
 * own bookkeeping: a test that reads the packer's file list would agree with
 * the packer's bug.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PACKER = join(REPO, 'extension', 'tools', 'pack-extension.mjs');
const BACKGROUND = join(REPO, 'extension', 'background.js');

/** The module paths named in background.js's importScripts() calls. */
function declaredImports() {
  const source = readFileSync(BACKGROUND, 'utf8');
  const found = [];
  for (const call of source.matchAll(/importScripts\s*\(([\s\S]*?)\)\s*;/g)) {
    for (const literal of call[1].matchAll(/['"]([^'"]+)['"]/g)) found.push(literal[1]);
  }
  return found;
}

/** Run the packer into a throwaway directory and return the ZIP bytes. */
function buildZip() {
  const out = mkdtempSync(join(tmpdir(), 'sm-pack-'));
  try {
    execFileSync(process.execPath, [PACKER, '--out', out], { cwd: REPO, stdio: 'pipe' });
    const name = readdirSync(out).find((file) => file.endsWith('.zip'));
    if (!name) throw new Error('packer wrote no zip');
    return readFileSync(join(out, name));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Entry names from the central directory.
 *
 * Read properly instead of searching the raw bytes: the body is deflated, so a
 * byte search can match compressed noise (false pass) and cannot distinguish a
 * file name from a string that merely appears inside another file.
 */
function zipEntries(zip: Buffer): string[] {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory header');
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe('release zip contents', () => {
  const imports = declaredImports();

  it('background.js declares imports at all', () => {
    // Guards the guard: if the regex stops matching, everything below passes
    // vacuously.
    expect(imports.length).toBeGreaterThan(0);
    expect(imports).toContain('shared/core.js');
  });

  it('includes every module the service worker imports', () => {
    const entries = zipEntries(buildZip());
    for (const entry of imports) {
      expect(entries, entry + ' missing from zip').toContain(entry);
    }
  });

  it('includes every content script from the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'extension', 'manifest.json'), 'utf8'));
    const entries = zipEntries(buildZip());
    for (const script of manifest.content_scripts) {
      for (const js of script.js) expect(entries, js + ' missing from zip').toContain(js);
    }
  });

  it('ships no development or secret files', () => {
    const entries = zipEntries(buildZip());
    for (const entry of entries) {
      expect(entry.startsWith('tools/'), entry + ' should not ship').toBe(false);
      expect(entry.startsWith('server/'), entry + ' should not ship').toBe(false);
      expect(entry.startsWith('.backup-'), entry + ' should not ship').toBe(false);
      expect(entry.endsWith('extension.pem'), entry + ' should not ship').toBe(false);
      expect(entry.split('/').pop()?.startsWith('.env'), entry + ' should not ship').toBe(false);
    }
  });

  it('keeps ZIP entry names forward-slashed', () => {
    // A backslash name is one file to a strict reader; it happened on Windows
    // when path.join() fed the allowlist.
    for (const entry of zipEntries(buildZip())) expect(entry).not.toContain('\\');
  });
});
