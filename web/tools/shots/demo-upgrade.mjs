// Spike diagnostics: a returning visitor after a redeploy. Visit and log in, swap in a
// worker from a different build (the caller does that between the two phases), then
// visit again and check the old database was replaced.
//   node tools/shots/demo-upgrade.mjs <profileDir> first|second
import { chromium } from 'playwright';

const [profile, phase] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(profile, {});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/status of 40[49]/.test(m.text()) && errors.push(m.text().slice(0, 300)));
ctx.on('serviceworker', (w) => w.on('console', (m) => (m.type() === 'error' || /\[demo\]/.test(m.text())) && errors.push('sw: ' + m.text().slice(0, 300))));
await page.goto('http://localhost:4400/login');
if (phase === 'first') {
  await page.waitForSelector('input[type=email]', { timeout: 60_000 });
  await page.fill('input[type=email]', 'admin@example.com');
  await page.fill('input[type=password]', 'correct horse battery');
  await page.click('button:has-text("Log in")');
  await page.waitForURL('**/home');
} else {
  // The browser fetches the new worker on navigation; reload once it has taken over.
  await page.waitForTimeout(3000);
  await page.goto('http://localhost:4400/tasks');
  await page.waitForFunction(() => !!document.querySelector('input[type=email], nav'), null, { timeout: 30_000 });
}
await page.waitForTimeout(1500);
const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.includes('patrice')));
console.log(`${phase}: url=${new URL(page.url()).pathname} databases=${JSON.stringify(dbs)}`);
console.log(`  errors: ${errors.length ? errors.join('\n  ') : 'none'}`);
await ctx.close();
