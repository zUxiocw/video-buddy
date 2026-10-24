import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate a bundled JSON file under `server/data/` from a module inside the
 * source tree.
 *
 * A fixed `../../data` no longer works: the shared voice rules live in
 * `extension/shared/*.js`, which forces `rootDir: ".."` and puts the emit one
 * directory deeper (`dist/server/src/...` instead of `dist/...`). Walking up
 * until the file is found works for both layouts — `tsx` runs from
 * `src/trends/`, the build runs from `dist/server/src/trends/` — and keeps
 * working if the emit path shifts again.
 *
 * Throws rather than returning null: a missing lexicon file is a packaging
 * bug, and silently falling back to an empty lexicon would be much harder to
 * notice.
 */
export function dataFile(name: string, fromModule: string): string {
  let dir = dirname(fileURLToPath(fromModule));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, 'data', name);
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error(`data/${name} not found above ${fileURLToPath(fromModule)}`);
}
