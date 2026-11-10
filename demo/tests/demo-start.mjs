// The demo's start page, end to end in a fresh browser: a deep link sends a new visitor
// to the start page, Start shows each step and lands on the login page (which shows the
// demo login), then Clear removes the data.   node tests/demo-start.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4400';
const OUT = process.argv[2] ?? '.build/screenshots/demo-start';
mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-start-')), {
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: 1.25,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => console.log('pageerror', (e.stack ?? e.message).split(/\r?\n/).slice(0, 3).join(' / ')));
page.on('dialog', (d) => d.accept());
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

await page.goto(`${BASE}/tasks`);
await page.waitForURL((u) => u.pathname.startsWith('/demo'));
await page.waitForSelector('#start:not([disabled])');
console.log('1. deep link ->', new URL(page.url()).pathname + new URL(page.url()).search);
console.log('   status:', await page.textContent('#status-text'));
await shot('1-start-page');

await page.click('#start');
// Catch a mid-way frame of the progress list.
await page.waitForSelector('.step.active[data-id="database"], .step.active[data-id="policy"], .step.active[data-id="api"]', { timeout: 20_000 }).catch(() => {});
await shot('2-starting');
await page.waitForSelector('.step.active[data-id="open"]', { timeout: 60_000 });
console.log('2. steps:', await page.$$eval('.step', (els) => els.map((e) => `${e.dataset.id}=${e.className.replace('step', '').trim()}`).join(' ')));
await shot('3-ready');
await page.waitForURL((u) => !u.pathname.startsWith('/demo'), { timeout: 15_000 });
await page.waitForSelector('input[type=email]', { timeout: 30_000 });
console.log('3. landed on', new URL(page.url()).pathname);
console.log('   labels:', await page.$$eval('.auth label', (ls) => ls.map((l) => l.textContent.trim()).join(' | ')));
await shot('4-login');

await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20_000 });
console.log('4. logged in ->', new URL(page.url()).pathname);

// Back to the start page: it sees the data, then clears it.
await page.goto(`${BASE}/demo`);
await page.waitForSelector('#clear:not([disabled])');
console.log('5. status:', await page.textContent('#status-text'));
await shot('5-start-page-with-data');
await page.click('#clear');
await page.waitForFunction(() => document.getElementById('status-text').textContent.includes('cleared'), null, { timeout: 20_000 });
const left = await page.evaluate(async () => ({
  workers: (await navigator.serviceWorker.getRegistrations()).length,
  databases: ((await indexedDB.databases()) ?? []).filter((d) => d.name.includes('patrice')).map((d) => d.name),
}));
console.log('6. after clear:', await page.textContent('#status-text'), JSON.stringify(left));
if (left.workers || left.databases.length) {
  console.log('FAIL Clear left the worker or database behind');
  process.exit(1);
}
await shot('6-cleared');

// A visit after clearing goes back to the start page.
await page.goto(`${BASE}/home`);
await page.waitForURL((u) => u.pathname.startsWith('/demo'));
console.log('7. after clear, /home ->', new URL(page.url()).pathname + new URL(page.url()).search);
await ctx.close();
