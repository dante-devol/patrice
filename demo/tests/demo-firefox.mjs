// Spike diagnostics: load the demo in Firefox, optionally with DevTools open from the
// start (`-devtools`), and report whether the app comes up.
//   node tests/demo-firefox.mjs [devtools] [extra firefox prefs as k=v ...]
import { firefox } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const withDevtools = process.argv.includes('devtools');
const prefs = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.includes('='))
    .map((a) => {
      const [k, v] = a.split('=');
      return [k, v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v];
    }),
);
const t0 = Date.now();
const t = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const ctx = await firefox.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-ff-')), {
  headless: false,
  args: withDevtools ? ['-devtools'] : [],
  firefoxUserPrefs: prefs,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => console.log(`${t()} [${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => console.log(`${t()} pageerror ${e.message}`));
await page.goto('http://localhost:4400/login');
try {
  await page.waitForSelector('input[type=email]', { timeout: 40_000 });
  console.log(`${t()} RESULT: login page rendered (devtools=${withDevtools})`);
} catch {
  const state = await page
    .evaluate(async () => ({
      controller: !!navigator.serviceWorker.controller,
      regs: (await navigator.serviceWorker.getRegistrations()).map((r) => ({
        active: r.active?.state,
        installing: r.installing?.state,
        waiting: r.waiting?.state,
      })),
      note: document.body.innerText.slice(0, 120),
    }))
    .catch((e) => String(e));
  console.log(`${t()} RESULT: HUNG (devtools=${withDevtools}) ${JSON.stringify(state)}`);
}
await ctx.close();
