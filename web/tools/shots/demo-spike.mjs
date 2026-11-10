// Spike check: the static demo site in a real Chromium. The service worker runs the
// API; this logs in through the normal UI and captures a few pages.
//   node tools/shots/demo-spike.mjs http://localhost:4400 <outDir>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:4400';
const OUT = process.argv[3] ?? 'screenshots/demo-spike';
mkdirSync(OUT, { recursive: true });

// A persistent profile: service workers need real (non-incognito) storage.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-demo-')), {
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 1.25,
});
const browser = ctx;
const page = ctx.pages()[0] ?? (await ctx.newPage());
const t = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const t0 = Date.now();
page.on('console', (m) => console.log(`[page ${t()}] ${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => console.log(`[page ${t()}] error: ${e.message}`));
ctx.on('serviceworker', (w) => w.on('console', (m) => console.log(`[sw ${t()}] ${m.type()}: ${m.text()}`)));
const failed = [];
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});

await page.goto(`${BASE}/login`);
await page.waitForSelector('input[type=email]', { timeout: 60_000 });
console.log(`login page at ${t()}`);
await page.screenshot({ path: join(OUT, '1-login.png') });
await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL('**/home', { timeout: 30_000 });
await page.waitForTimeout(1500);
console.log(`home at ${t()}`);
await page.screenshot({ path: join(OUT, '2-home.png') });

await page.goto(`${BASE}/tasks`);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, '3-tasks.png') });

// A write: claim the first open task, through the UI's API.
const claim = await page.evaluate(async () => {
  const csrf = document.cookie.match(/patrice_csrf=([^;]+)/)?.[1];
  const list = await (await fetch('/api/tasks?status=open')).json();
  const task = (list.items ?? list)[0];
  const r = await fetch(`/api/tasks/${task.id}/claim`, { method: 'POST', headers: { 'x-csrf-token': decodeURIComponent(csrf ?? '') } });
  return { status: r.status, task: task.name, csrf: !!csrf };
});
console.log('claim via API:', JSON.stringify(claim));

const divisions = await page.evaluate(async () => (await (await fetch('/api/divisions')).json()).map((d) => [d.id, d.name]));
const writing = divisions.find(([, n]) => n === 'Writing');
await page.goto(`${BASE}/divisions/${writing[0]}`);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, '4-division.png'), fullPage: true });

await page.goto(`${BASE}/admin`);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, '5-admin.png') });

// Reload: the session and the claim survive (IndexedDB + the worker's cookie jar).
await page.reload();
await page.waitForTimeout(2500);
console.log('after reload, url:', page.url());

console.log('failed API calls:', failed.length ? failed.join('\n  ') : 'none');
await browser.close();
