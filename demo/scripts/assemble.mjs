// Put the static demo site together: the web app's production build, the API service
// worker and its files, and the boot script, which starts Angular once the worker is
// in control. Output is a plain folder any static host (Cloudflare Pages) can serve.
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(process.argv[2] ?? join(demo, '.build/site'));
const worker = join(demo, '.build/worker');
const web = resolve(demo, '../web/dist/patrice-web/browser');

cpSync(web, site, { recursive: true });
for (const f of readdirSync(worker)) cpSync(join(worker, f), join(site, f));
cpSync(join(demo, 'web/boot.js'), join(site, 'demo-boot.js'));
cpSync(join(demo, 'web/header.js'), join(site, 'demo-header.js'));
// The demo header, first thing in <body> on every page (it inserts itself above the app).
const headerScript = '<script src="/demo-header.js"></script>';
const withHeader = (html) => {
  if (!/<body[^>]*>/.test(html)) throw new Error('no <body> to put the demo header in');
  return html.replace(/<body[^>]*>/, (tag) => `${tag}${headerScript}`);
};

// The demo login: the seed script's defaults (the snapshot is seeded with them), read
// from the script so the two can't disagree. The start page shows them.
const seed = readFileSync(join(demo, '../api/scripts/seed.mjs'), 'utf8');
const login = {
  email: /ADMIN_EMAIL = arg\('--email', '([^']+)'\)/.exec(seed)?.[1],
  password: /PASSWORD = arg\('--password', '([^']+)'\)/.exec(seed)?.[1],
};
if (!login.email || !login.password) throw new Error('could not read the demo login from api/scripts/seed.mjs');
const loginScript = `<script>window.patriceDemo=${JSON.stringify(login)}</script>`;

const startPage = withHeader(
  readFileSync(join(demo, 'web/demo.html'), 'utf8').replace('<script>', `${loginScript}\n    <script>`),
);
writeFileSync(join(site, 'demo.html'), startPage);

const indexPath = join(site, 'index.html');
let html = withHeader(readFileSync(indexPath, 'utf8'));
const scripts = [];
html = html.replace(/<script src="([^"]+)" type="module"><\/script>/g, (_m, src) => {
  scripts.push(src);
  return '';
});
if (!scripts.length) throw new Error('no module scripts found in index.html');
html = html.replace(
  '</body>',
  `${loginScript}<script>window.DEMO_SCRIPTS=${JSON.stringify(scripts)}</script><script src="demo-boot.js"></script></body>`,
);
writeFileSync(indexPath, html);
// Cloudflare response headers. Every page: no framing by other sites, no content-type
// guessing, no referrer to other sites, not indexed by search engines, no access to
// camera, microphone or location.
writeFileSync(
  join(site, '_headers'),
  [
    '/*',
    '  X-Frame-Options: DENY',
    "  Content-Security-Policy: frame-ancestors 'none'",
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  X-Robots-Tag: noindex',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    '',
    '/*.wasm',
    '  Content-Type: application/wasm',
    '',
    '/*.data',
    '  Content-Type: application/octet-stream',
    '',
  ].join('\n'),
);
// The site's front door is the start page, whether or not the demo is set up yet.
writeFileSync(join(site, '_redirects'), '/  /demo  302\n');
console.log(`site -> ${site} (${scripts.length} app scripts deferred)`);
