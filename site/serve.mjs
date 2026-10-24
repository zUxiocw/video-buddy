import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  // Cloudflare serves the release ZIP as application/zip. Without this the
  // preview reports application/octet-stream and the deploy checker's
  // content-type assertion can only ever fail locally.
  '.zip': 'application/zip',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  // Cloudflare redirects /contact.html to /contact, so the checker's extensionless
  // routes have to resolve here too — otherwise the preview answers 404 for a
  // path that is fine in production, and every local run "fails" for the wrong
  // reason. Only exact sibling .html files are matched, not a general SPA
  // fallback: /nope must still be a 404.
  if (!extname(file)) {
    try {
      const body = await readFile(file + '.html');
      response.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store' });
      response.end(body);
      return;
    } catch { /* fall through to the normal read below */ }
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    // Serve the real 404 page, the way Cloudflare does once 404.html exists at
    // the deployment root. Without this the page can only be seen after a
    // deploy, and its own links would be untested until then.
    try {
      const page = await readFile(join(root, '404.html'));
      response.writeHead(404, { 'content-type': types['.html'], 'cache-control': 'no-store' });
      response.end(page);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[site] http://127.0.0.1:${port}`);
});
