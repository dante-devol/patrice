// Put the static demo site together: the web app's production build, the API service
// worker and its files, and the boot script, which starts Angular once the worker is
// in control. Output is a plain folder any static host (Cloudflare Pages) can serve.
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(process.argv[2] ?? join(here, 'site'));
const web = resolve(here, '../../web/dist/patrice-web/browser');

cpSync(web, site, { recursive: true });
for (const f of readdirSync(join(here, 'out'))) cpSync(join(here, 'out', f), join(site, f));
cpSync(join(here, 'boot.js'), join(site, 'demo-boot.js'));

// The demo login: the seed script's defaults (the snapshot is seeded with them), read
// from the script so the two can't disagree. The app and the start page show them.
const seed = readFileSync(join(here, '../scripts/seed.mjs'), 'utf8');
const login = {
  email: /ADMIN_EMAIL = arg\('--email', '([^']+)'\)/.exec(seed)?.[1],
  password: /PASSWORD = arg\('--password', '([^']+)'\)/.exec(seed)?.[1],
};
if (!login.email || !login.password) throw new Error('could not read the demo login from scripts/seed.mjs');
const loginScript = `<script>window.patriceDemo=${JSON.stringify(login)}</script>`;

const startPage = readFileSync(join(here, 'demo.html'), 'utf8').replace('<script>', `${loginScript}\n    <script>`);
writeFileSync(join(site, 'demo.html'), startPage);

const indexPath = join(site, 'index.html');
let html = readFileSync(indexPath, 'utf8');
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
// Cloudflare Pages: serve index.html for app routes (it does by default without a 404.html).
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
