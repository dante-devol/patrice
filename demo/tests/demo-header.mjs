// The demo header: only the way back before the demo is started; then the start page
// link and who you're signed in as, following logins and logouts made in the app; and
// it must not get in the app's way (its sticky top bar still sticks to the top).
//   BASE_URL=http://localhost:4400 node tests/demo-header.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4400';
const OUT = process.argv[2] ?? '.build/screenshots/demo-header';
mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-header-')), {
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1.25,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('pageerror', e.message));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
// What the header shows, read through its shadow root.
const header = () =>
  page.evaluate(() => {
    const root = document.querySelector('patrice-demo-header')?.shadowRoot;
    if (!root) return null;
    const started = root.querySelector('.started');
    return {
      home: root.querySelector('.home')?.getAttribute('href'),
      started: !!started && !started.hidden,
      who: root.querySelector('.who .label')?.textContent?.trim(),
      startCurrent: root.querySelector('.start')?.getAttribute('aria-current') === 'page',
      first: document.body.firstElementChild?.tagName.toLowerCase(),
    };
  });
const waitWho = (text) =>
  page.waitForFunction(
    (t) => document.querySelector('patrice-demo-header')?.shadowRoot?.querySelector('.who .label')?.textContent?.includes(t),
    text,
    { timeout: 15_000 },
  );
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });

// 1. Before the demo is started: just the way back.
await page.goto(`${BASE}/demo`);
await page.waitForSelector('#start:not([disabled])');
let h = await header();
check(h?.first === 'patrice-demo-header', 'header is the first thing on the start page');
check(h?.home === 'https://dante-devol.dev', 'back link goes to https://dante-devol.dev');
check(h && !h.started, 'before starting, only the back link shows');
await shot('1-start-page-not-started');

// 2. Started: into the app, not signed in yet.
await page.click('#start');
await page.waitForSelector('input[type=email]', { timeout: 60_000 });
await waitWho('Anonymous').catch(() => {});
h = await header();
check(h?.started && h.who?.startsWith('Anonymous'), `in the app, not signed in: "${h?.who}"`);
check(h?.first === 'patrice-demo-header', 'header sits above the app');
const layout = await page.evaluate(() => {
  const demo = document.querySelector('patrice-demo-header').getBoundingClientRect();
  const app = document.querySelector('app-root').getBoundingClientRect();
  return { demoBottom: demo.bottom, appTop: app.top };
});
check(layout.appTop >= layout.demoBottom - 0.5, `the app starts below the header (${layout.demoBottom}px, app at ${layout.appTop}px)`);
await shot('2-login-not-signed-in');

// 3. Logging in through the app updates the header without a reload.
await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20_000 });
await waitWho('Viewing as').catch(() => {});
h = await header();
check(h?.who === 'Viewing as Admin', `after logging in: "${h?.who}"`);
await shot('3-home-signed-in');

// 4. Scrolled down a long page: the header scrolls away, the app's bar still sticks to the top.
const divisions = await page.evaluate(async () => (await (await fetch('/api/divisions')).json()).map((d) => d.id));
await page.setViewportSize({ width: 1200, height: 420 });
await page.goto(`${BASE}/divisions/${divisions[0]}`);
await page.waitForTimeout(2000);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(400);
const sticky = await page.evaluate(() => ({
  scrollY: Math.round(scrollY),
  appBarTop: document.querySelector('app-root header')?.getBoundingClientRect().top,
  demoBottom: document.querySelector('patrice-demo-header').getBoundingClientRect().bottom,
}));
check(
  sticky.scrollY > 100 && sticky.appBarTop === 0 && sticky.demoBottom <= 0,
  `scrolled ${sticky.scrollY}px: app bar at ${sticky.appBarTop}px, header off-screen (${sticky.demoBottom}px)`,
);
await shot('4-scrolled');
await page.mouse.wheel(0, -2000);
await page.setViewportSize({ width: 1200, height: 800 });

// 5. Logging out through the app updates it too.
await page.click('text=Log out');
await page.waitForURL('**/login', { timeout: 15_000 }).catch(() => {});
await waitWho('Anonymous').catch(() => {});
h = await header();
check(h?.who?.startsWith('Anonymous'), `after logging out: "${h?.who}"`);

// 6. Back on the start page: the full header, with "Start page" marked as current; then Clear.
await page.goto(`${BASE}/demo`);
await page.waitForSelector('#clear:not([disabled])');
await page.waitForTimeout(800);
h = await header();
check(h?.started && h.startCurrent, 'start page, once started: full header, "Start page" current');
await shot('5-start-page-started');
await page.click('#clear');
await page.waitForFunction(() => document.getElementById('status-text').textContent.includes('cleared'), null, { timeout: 20_000 });
await page.waitForTimeout(500);
h = await header();
check(h && !h.started, 'after Clear: back to only the back link');

await ctx.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall header checks passed');
process.exit(failures ? 1 : 0);
