// One-off screenshots of the division page's status chart (stacked, proportional,
// table, filtered). Needs the web dev server and an API on seeded test data:
//   BASE_URL=http://localhost:4300 OUT=<dir> node tools/shots/unit-chart.mjs <divisionId>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4300';
const OUT = process.env.OUT ?? 'screenshots';
const divisionId = process.argv[2];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });

await page.goto(`${BASE}/login`);
await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL('**/home');

await page.goto(`${BASE}/divisions/${divisionId}`);
await page.waitForSelector('status-chart svg');
const section = async (name) => {
  // Heading, toolbar, filter panel (when open) and the chart's sheet.
  const top = await page.locator('h2:has-text("Last 12 weeks")').boundingBox();
  const teams = await page.locator('h2:has-text("Teams"), h2:has-text("Leadership")').first().boundingBox();
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    fullPage: true,
    clip: { x: 0, y: top.y - 20, width: 1280, height: teams.y - top.y + 4 },
  });
};

// 1. Stacked, hovering a week.
const svg = page.locator('status-chart svg');
const box = await svg.boundingBox();
await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
await page.waitForSelector('status-chart .tip');
await section('1-stacked');

// 2. Proportional.
await page.click('button[role=tab]:has-text("Proportional")');
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
await section('2-proportional');

// 3. Table.
await page.mouse.move(0, 0);
await page.click('button[role=tab]:has-text("Table")');
await page.waitForSelector('table.data');
await section('3-table');

// 4. Filtered: Drafts only, claimed by Devin, with retired shown; back on Stacked.
await page.click('button[role=tab]:has-text("Stacked")');
await page.click('button:has-text("Filter")');
await page.check('unit-filter label:has-text("Drafts") input');
await page.check('unit-filter label:has-text("Retired") input');
await page.selectOption('unit-filter select[aria-label="Add claimed by"]', { label: 'Maya Ortiz' });
await page.waitForTimeout(800);
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5 + 220);
await section('4-filtered-stacked');

// 5. The same filter in the table, and the task list below following it.
await page.mouse.move(0, 0);
await page.click('button[role=tab]:has-text("Table")');
await page.waitForTimeout(300);
await section('5-filtered-table');
const list = await page.locator('task-list').boundingBox();
await page.screenshot({ path: join(OUT, '6-filtered-task-list.png'), fullPage: true, clip: { x: 0, y: list.y - 10, width: 1280, height: Math.min(list.height + 20, 700) } });

await browser.close();
console.log('saved to', OUT);
