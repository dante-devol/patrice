// The site's root goes to the start page, both before and after the demo is set up.
//   BASE_URL=http://localhost:4400 node tests/demo-root.mjs [screenshot.png]
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4400';
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-root-')), {
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: 1.25,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const where = () => new URL(page.url()).pathname + new URL(page.url()).search;

await page.goto(`${BASE}/`);
await page.waitForSelector('#start:not([disabled])');
console.log(`fresh visitor, / -> ${where()}`);
if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });

// Set up and log in, then come back to the root.
await page.click('#start');
await page.waitForSelector('input[type=email]', { timeout: 60_000 });
await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20_000 });
console.log(`logged in at ${where()}`);
await page.goto(`${BASE}/`);
await page.waitForSelector('#start:not([disabled])');
console.log(`set-up visitor, / -> ${where()} (button: ${await page.textContent('#start')})`);
// Continue goes into the app; a logged-in visitor ends up past the login page.
await page.click('#start');
await page.waitForURL((u) => !u.pathname.startsWith('/demo'), { timeout: 30_000 });
await page.waitForTimeout(1500);
console.log(`continue -> ${where()}`);
// Other app routes still work as before.
await page.goto(`${BASE}/tasks`);
await page.waitForTimeout(1500);
console.log(`/tasks -> ${where()}`);
await ctx.close();
