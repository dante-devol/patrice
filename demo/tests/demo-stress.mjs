// Spike diagnostics for the browser demo: browse quickly (parallel requests), reload,
// hard-reload, open a second visit on an existing database, and report every API
// failure plus the service worker's own errors (via CDP).
//   node tests/demo-stress.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:4400';
const profile = mkdtempSync(join(tmpdir(), 'patrice-stress-'));
const t0 = Date.now();
const t = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const failures = [];
const swErrors = [];

async function open() {
  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 860 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);
  cdp.on('ServiceWorker.workerErrorReported', (e) => swErrors.push(`${t()} ${e.errorMessage.errorMessage.slice(0, 700)}`));
  await cdp.send('ServiceWorker.enable');
  page.on('response', async (r) => {
    if (!r.url().includes('/api/') || r.status() < 500) return;
    let body = '';
    try {
      body = (await r.text()).slice(0, 300);
    } catch {}
    failures.push(`${t()} ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname} ${body}`);
  });
  page.on('pageerror', (e) => failures.push(`${t()} pageerror ${e.message.slice(0, 200)}`));
  const consoleErr = (src) => (m) => {
    if (m.type() === 'error' || /Prisma|Unhandled/.test(m.text())) failures.push(`${t()} ${src} console.${m.type()}: ${m.text().slice(0, 400)}`);
  };
  page.on('console', consoleErr('page'));
  ctx.on('serviceworker', (w) => w.on('console', consoleErr('sw')));
  for (const w of ctx.serviceWorkers()) w.on('console', consoleErr('sw'));
  return { ctx, page };
}

async function waitForApp(page, label) {
  try {
    await page.waitForFunction(() => !!document.querySelector('app-root *, input[type=email], nav'), null, { timeout: 25_000 });
    console.log(`${t()} ${label}: app rendered`);
    return true;
  } catch {
    const note = await page.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => '?');
    const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => '?');
    console.log(`${t()} ${label}: HUNG (controller=${ctl}) page says: ${JSON.stringify(note)}`);
    return false;
  }
}

// Visit 1: fresh profile, log in, click around fast.
let { ctx, page } = await open();
// A new visitor starts the demo from its start page, which then opens the app.
await page.goto(`${BASE}/demo`);
await page.click('#start:not([disabled])');
await waitForApp(page, 'first visit');
await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL('**/home', { timeout: 30_000 }).catch(() => console.log(`${t()} login did not reach /home`));
const divisions = await page.evaluate(async () => (await (await fetch('/api/divisions')).json()).map((d) => d.id));
const routes = ['/tasks', ...divisions.map((d) => `/divisions/${d}`), '/admin', '/admin/users', '/admin/permissions', '/admin/activity', '/home'];
for (let round = 0; round < 2; round++) {
  for (const r of routes) {
    await page.goto(`${BASE}${r}`);
    await page.waitForTimeout(400);
  }
}
// Parallel burst like a busy page, including writes.
const burst = await page.evaluate(async () => {
  const csrf = decodeURIComponent(document.cookie.match(/patrice_csrf=([^;]+)/)?.[1] ?? '');
  const tasks = await (await fetch('/api/tasks')).json();
  const items = tasks.items ?? tasks;
  const reqs = [];
  for (let i = 0; i < 20; i++) reqs.push(fetch('/api/tasks').then((r) => r.status));
  for (const task of items.slice(0, 5)) {
    reqs.push(fetch(`/api/tasks/${task.id}`).then((r) => r.status));
    reqs.push(fetch(`/api/tasks/${task.id}/claim`, { method: 'POST', headers: { 'x-csrf-token': csrf } }).then((r) => r.status));
  }
  return (await Promise.all(reqs)).reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
});
console.log(`${t()} parallel burst statuses: ${JSON.stringify(burst)}`);

// Chrome stops an idle worker after ~30 s; the next request restarts it on the same
// IndexedDB database. Force that a few times, with requests in flight.
const sw = await ctx.newCDPSession(page);
await sw.send('ServiceWorker.enable');
for (let i = 0; i < 3; i++) {
  await page.goto(`${BASE}/tasks`);
  await page.waitForTimeout(300);
  await sw.send('ServiceWorker.stopAllWorkers');
  await page.goto(`${BASE}/divisions/${divisions[0]}`);
  await waitForApp(page, `after worker stop ${i + 1}`);
  await page.waitForTimeout(800);
}
// Stop it in the middle of a write burst.
const midWrite = page.evaluate(async () => {
  const csrf = decodeURIComponent(document.cookie.match(/patrice_csrf=([^;]+)/)?.[1] ?? '');
  const items = (await (await fetch('/api/tasks')).json()).items;
  return Promise.all(items.slice(0, 6).map((t) => fetch(`/api/tasks/${t.id}/leave`, { method: 'POST', headers: { 'x-csrf-token': csrf } }).then((r) => r.status).catch((e) => String(e))));
});
await page.waitForTimeout(150);
await sw.send('ServiceWorker.stopAllWorkers');
console.log(`${t()} writes when stopped mid-burst: ${JSON.stringify(await midWrite)}`);
await page.goto(`${BASE}/home`);
await waitForApp(page, 'after mid-write stop');
// A real idle period with the notification stream open.
await page.waitForTimeout(45_000);
await page.goto(`${BASE}/tasks`);
await waitForApp(page, 'after 45 s idle');

// Normal reload, then a hard reload (bypasses the service worker for the page).
await page.reload();
await waitForApp(page, 'reload');
await page.reload({ waitUntil: 'load' });
await page.evaluate(() => location.reload()); // ordinary
await waitForApp(page, 'second reload');
const cdp2 = await ctx.newCDPSession(page);
await cdp2.send('Network.setBypassServiceWorker', { bypass: true });
await page.reload();
await cdp2.send('Network.setBypassServiceWorker', { bypass: false });
await waitForApp(page, 'hard reload (bypass SW)');
// Ctrl+Shift+R: the page loads without a controller even though the worker is active.
for (let i = 0; i < 2; i++) {
  await cdp2.send('Page.reload', { ignoreCache: true });
  await waitForApp(page, `ctrl+shift+r ${i + 1}`);
  console.log(`${t()}   controlled: ${await page.evaluate(() => !!navigator.serviceWorker.controller)}`);
}
await ctx.close();

// Visit 2: same profile (existing IndexedDB database), fresh browser process.
({ ctx, page } = await open());
await page.goto(`${BASE}/home`);
await waitForApp(page, 'return visit');
await page.waitForTimeout(2000);
await ctx.close();

console.log(`\nAPI 5xx / page errors (${failures.length}):\n  ${failures.join('\n  ') || 'none'}`);
console.log(`\nService worker errors (${swErrors.length}):\n  ${[...new Set(swErrors)].slice(0, 12).join('\n  ') || 'none'}`);
