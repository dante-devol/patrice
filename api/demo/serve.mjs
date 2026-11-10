// A plain static server for trying the demo locally, standing in for Cloudflare:
// files as-is, index.html for app routes. Nothing under /api exists here; the
// service worker answers those.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'demo/site');
const port = Number(process.argv[3] ?? 4400);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.gz': 'application/gzip', '.data': 'application/octet-stream',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Like Cloudflare: a file, else the same path with .html (/demo → demo.html), else
  // index.html for app routes.
  let file = join(root, 'index.html');
  for (const candidate of [join(root, path), join(root, `${path}.html`)]) {
    try {
      if ((await stat(candidate)).isFile()) {
        file = candidate;
        break;
      }
    } catch {
      // Not this one; try the next.
    }
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(await readFile(file));
}).listen(port, () => console.log(`demo site on http://localhost:${port}`));
