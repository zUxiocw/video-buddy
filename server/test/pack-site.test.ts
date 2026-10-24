/*
 * What site-dist/ contains is what the public sees.
 *
 * Two failure modes this guards, both silent without a test:
 *
 * 1. site/README.md and site/serve.mjs are working files that document internal
 *    decisions (why Firefox is unsupported, why there is no store listing).
 *    Serving them is not a crash, so nothing would report it.
 *
 * 2. site/app.js probes `download/<version>.zip` and falls back to a help
 *    dialog when it is absent. A staging run without the ZIP therefore produces
 *    a site that looks completely normal and can never deliver the extension.
 *    That is the outcome a human review misses most easily.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SITE_PACKER = join(REPO, 'tools', 'pack-site.mjs');
const EXT_PACKER = join(REPO, 'extension', 'tools', 'pack-extension.mjs');
const DOWNLOAD_DIR = join(REPO, 'site', 'download');

/** Stage into a throwaway dir and return { files, output }. */
function stage(): string[] {
  // The ZIP is a gitignored build product, so a fresh checkout has none. Build
  // it first: the packer refuses without it, which is the behaviour under test
  // elsewhere but not what this helper wants.
  if (!existsSync(DOWNLOAD_DIR) || !readdirSync(DOWNLOAD_DIR).some((f) => f.endsWith('.zip'))) {
    execFileSync(process.execPath, [EXT_PACKER, '--out', DOWNLOAD_DIR], { cwd: REPO, stdio: 'pipe' });
  }
  const out = mkdtempSync(join(tmpdir(), 'sm-site-'));
  try {
    execFileSync(process.execPath, [SITE_PACKER, '--out', out], { cwd: REPO, stdio: 'pipe' });
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(join(out, dir), { withFileTypes: true })) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else files.push(rel);
      }
    };
    walk('', '');
    return files.sort();
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe('site staging', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = stage();
  });

  it('publishes the four pages and their two shared files', () => {
    for (const page of ['index.html', 'demo.html', 'install.html', 'setup.html']) {
      expect(files, page).toContain(page);
    }
    expect(files).toContain('styles.css');
    expect(files).toContain('app.js');
  });

  it('holds back the working files that document internal decisions', () => {
    // Not a tidiness preference: README.md explains which browsers are
    // unsupported and that the store is deliberately not used yet.
    for (const entry of files) {
      const base = entry.split('/').pop();
      expect(base, entry + ' is an internal file').not.toBe('README.md');
      expect(base, entry + ' is a dev server').not.toBe('serve.mjs');
      expect(base, entry + ' is a placeholder').not.toBe('.gitkeep');
    }
  });

  it('ships the ZIP that the download button points at', () => {
    // The button reads this literal; if the two drift apart it silently shows
    // the fallback dialog forever and no one can download the extension.
    const source = readFileSync(join(REPO, 'site', 'app.js'), 'utf8');
    const url = source.match(/var DOWNLOAD_URL\s*=\s*'([^']+)'/)?.[1];
    expect(url, 'DOWNLOAD_URL literal in site/app.js').toBeTruthy();
    expect(files, 'staged file for ' + url).toContain(url);
  });

  it('ships every emotion icon the pages reference', () => {
    // The demo swaps faces by path; a missing PNG is a broken image, not an
    // error, so assert the directory came over whole.
    const icons = files.filter((file) => file.startsWith('assets/emotions/'));
    expect(icons.length).toBe(9);
    for (const icon of icons) expect(icon.endsWith('.png')).toBe(true);
  });

  it('refuses to stage when the ZIP is missing', () => {
    // Verified by behaviour, not by reading the source: move the ZIP aside,
    // expect a non-zero exit, then put it back.
    const zips = readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith('.zip'));
    const kept = zips.map((name) => ({ name, data: readFileSync(join(DOWNLOAD_DIR, name)) }));
    try {
      for (const zip of kept) rmSync(join(DOWNLOAD_DIR, zip.name));
      const out = mkdtempSync(join(tmpdir(), 'sm-noship-'));
      try {
        expect(() =>
          execFileSync(process.execPath, [SITE_PACKER, '--out', out], { cwd: REPO, stdio: 'pipe' })
        ).toThrow();
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    } finally {
      for (const zip of kept) writeFileSync(join(DOWNLOAD_DIR, zip.name), zip.data);
    }
  });
});
