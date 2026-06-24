// Full-app screenshot sweep against a live server (no API mocks).
// Logs in as an admin, visits every route, captures each admin tab.
//
//   node tools/screenshot-live.mjs
//
// Writes to web/tools/screenshots/live/

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const OUT  = join(dirname(fileURLToPath(import.meta.url)), 'screenshots', 'live');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// The notification SSE stream never closes → blocks networkidle. Abort it.
await page.route('**/notifications/stream', (route) => route.abort());
await page.route('**/stream**', (route) => route.abort());

async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log('  ✓', name);
}

// ── Unauthenticated pages ─────────────────────────────────────────────────

console.log('Unauthenticated pages…');

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await shot('login');

await page.goto(`${BASE}/forgot-password`, { waitUntil: 'networkidle' });
await shot('forgot-password');

await page.goto(`${BASE}/reset-password`, { waitUntil: 'networkidle' });
await shot('reset-password');

// ── Log in ────────────────────────────────────────────────────────────────

console.log('Logging in…');
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });

// Fill email + password
const emailField = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="Email" i]').first();
const passField  = page.locator('input[type="password"]').first();
const submitBtn  = page.locator('button[type="submit"], button').filter({ hasText: /log in|sign in|submit/i }).first();

await emailField.fill('test@test.com');
await passField.fill('test1234');
await submitBtn.click();

// Wait for redirect away from login
await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 }).catch(() => {});
console.log('  Landed on:', page.url());

// ── Authenticated pages ───────────────────────────────────────────────────

console.log('Authenticated pages…');

await page.goto(`${BASE}/home`, { waitUntil: 'networkidle' });
await shot('home');

await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shot('tasks-overview');

// Grab the first task link and visit it
const firstTaskLink = page.locator('a[href*="/tasks/"]').first();
const taskHref = await firstTaskLink.getAttribute('href').catch(() => null);
if (taskHref) {
  await page.goto(`${BASE}${taskHref}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot('task-detail');

  // Try opening a submission panel
  const viewBtn = page.getByRole('button', { name: /view submission/i }).first();
  if (await viewBtn.isVisible().catch(() => false)) {
    await viewBtn.click();
    await page.waitForTimeout(400);
    await shot('task-detail-submission-panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // Try submit-work button
  const submitBtn2 = page.getByRole('button', { name: /submit work/i }).first();
  if (await submitBtn2.isVisible().catch(() => false)) {
    await submitBtn2.click();
    await page.waitForTimeout(400);
    await shot('task-detail-submit-dialog');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
} else {
  console.log('  (no task links found)');
}

// Tasks with create modal open
await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
const requestBtn = page.getByRole('button', { name: /request a task/i }).first();
if (await requestBtn.isVisible().catch(() => false)) {
  await requestBtn.click();
  await page.waitForTimeout(500);
  await shot('tasks-create-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// Invitations
await page.goto(`${BASE}/invitations`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot('invitations');

// Verify email page
await page.goto(`${BASE}/verify-email`, { waitUntil: 'networkidle' });
await shot('verify-email');

// ── Admin — all tabs ──────────────────────────────────────────────────────

console.log('Admin tabs…');

await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('admin-default');

const adminTabs = ['roles', 'divisions', 'teams', 'users', 'permissions', 'settings'];
for (const tab of adminTabs) {
  // Click by matching the tab button text
  const tabBtn = page.getByRole('button', { name: new RegExp(`^${tab}$`, 'i') })
    .or(page.locator(`button`).filter({ hasText: new RegExp(`^${tab}$`, 'i') }))
    .first();
  if (await tabBtn.isVisible().catch(() => false)) {
    await tabBtn.click();
    await page.waitForTimeout(500);
    await shot(`admin-${tab}`);
  } else {
    console.log(`  (tab "${tab}" not found, skipping)`);
  }
}

await browser.close();
console.log('\nAll screenshots written to', OUT);
