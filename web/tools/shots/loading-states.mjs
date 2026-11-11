// Loading states: hold every /api response for a moment, screenshot each page while it
// loads, then let it finish and check the real content arrives. Also exercises the
// Admin > Users search.
//   BASE_URL=http://localhost:4300 node tools/shots/loading-states.mjs [outDir]
// Logs in with LOGIN_EMAIL / LOGIN_PASSWORD (default: the dev seed's admin).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4300';
const OUT = process.argv[2] ?? 'tools/screenshots/loading-states';
const EMAIL = process.env.LOGIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.LOGIN_PASSWORD ?? 'correct horse battery';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.25 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

await page.goto(`${BASE}/login`);
await page.fill('input[type=email]', EMAIL);
await page.fill('input[type=password]', PASSWORD);
await page.click('button:has-text("Log in")');
await page.waitForURL('**/home', { timeout: 20_000 });

// From here on, every API answer is held until released.
let held = [];
let holding = false;
await page.route('**/api/**', async (route) => {
  if (!holding || route.request().url().includes('/notifications/stream')) return route.continue();
  await new Promise((resolve) => held.push(resolve));
  await route.continue();
});
const release = () => {
  holding = false;
  held.forEach((r) => r());
  held = [];
};

// [screenshot name, page, admin tab (clicked), what shows while loading]
const PAGES = [
  ['home', '/home', null, 'loading-rows, loading-value'],
  ['tasks', '/tasks', null, 'loading-rows, loading-value'],
  ['admin-roles', '/admin', null, 'tbody[loadingrows]'],
  ['admin-divisions', '/admin', 'divisions', 'tbody[loadingrows]'],
  ['admin-teams', '/admin', 'teams', 'tbody[loadingrows]'],
  ['admin-users', '/admin', 'users', 'loading-rows'],
  ['admin-permissions', '/admin', 'permissions', 'loading-rows'],
  ['admin-activity', '/admin', 'activity', 'tbody[loadingrows]'],
  ['admin-invitations', '/admin', 'invitations', 'tbody[loadingrows]'],
];

const openUsersTab = async () => {
  await page.goto(`${BASE}/admin`);
  await page.click('.admin-tab:text-is("users")');
};

for (const [name, url, tab, selector] of PAGES) {
  const path = tab ? `${url} > ${tab}` : url;
  if (tab) {
    // Open Admin normally, then hold the tab's own requests.
    await page.goto(`${BASE}${url}`);
    await page.waitForTimeout(800);
    holding = true;
    await page.click(`.admin-tab:text-is("${tab}")`);
  } else {
    // Arrive the way people do: through the app's nav, so only the page's own data
    // loads (a full page load first checks who you are, before any page renders).
    await page.goto(`${BASE}${url === '/home' ? '/tasks' : '/home'}`);
    await page.waitForTimeout(800);
    holding = true;
    await page.click(`header.appshell a[href="${url}"]:not(.font-display)`);
  }
  const shown = await page.waitForSelector(selector, { timeout: 10_000 }).then(() => true, () => false);
  check(shown, `${path}: placeholders while loading`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}-loading.png`) });
  release();
  const gone = await page
    .waitForFunction((sel) => !document.querySelector(sel), selector, { timeout: 15_000 })
    .then(() => true, () => false);
  check(gone, `${path}: placeholders replaced by the content`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}-loaded.png`) });
}

// Admin > Users: the search narrows the list, says how many it shows, and clears.
await openUsersTab();
await page.waitForSelector('.person', { timeout: 15_000 });
const all = await page.locator('.person').count();
const first = (await page.locator('.person .person-name').first().textContent()).trim().split(/\s+/)[0];
await page.fill('input[type=search]', first.slice(0, 4));
await page.waitForTimeout(200);
const some = await page.locator('.person').count();
const summary = await page.locator('.search [aria-live]').textContent();
check(some >= 1 && some <= all, `search "${first.slice(0, 4)}": ${some} of ${all} people (${summary.trim()})`);
await page.screenshot({ path: join(OUT, 'admin-users-search.png') });
await page.fill('input[type=search]', 'zzzz-nobody');
await page.waitForTimeout(200);
check((await page.locator('.person').count()) === 0 && (await page.isVisible('text=No one matches')), 'a search with no match says so');
await page.click('.search button:has-text("Clear")');
await page.waitForTimeout(200);
check((await page.locator('.person').count()) === all, 'Clear brings everyone back');

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall loading checks passed');
process.exit(failures ? 1 : 0);
