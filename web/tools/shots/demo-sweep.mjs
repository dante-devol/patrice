// Spike diagnostics: in Chromium, through the demo's service worker, call every GET
// route in the API contract plus a set of writes, and report anything that fails or
// mentions Prisma.   node tools/shots/demo-sweep.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:4400';
const routes = [...readFileSync(new URL('../../../api/src/contract/routes.ts', import.meta.url), 'utf8').matchAll(/(\w+): r\(\{ method: '(get|post|patch|put|delete)', path: '([^']+)'/g)].map((m) => ({ name: m[1], method: m[2], path: m[3] }));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-sweep-')), {});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const logs = [];
const grab = (src) => (m) => {
  if (m.type() === 'error' || /Prisma/.test(m.text())) logs.push(`${src}: ${m.text().slice(0, 500)}`);
};
page.on('console', grab('page'));
ctx.on('serviceworker', (w) => w.on('console', grab('sw')));
await page.goto(`${BASE}/login`);
await page.waitForSelector('input[type=email]', { timeout: 60_000 });
await page.fill('input[type=email]', 'admin@example.com');
await page.fill('input[type=password]', 'correct horse battery');
await page.click('button:has-text("Log in")');
await page.waitForURL('**/home');

const report = await page.evaluate(async (routes) => {
  const csrf = () => decodeURIComponent(document.cookie.match(/patrice_csrf=([^;]+)/)?.[1] ?? '');
  const call = async (method, path, body) => {
    const r = await fetch('/api' + path, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = r.type === 'opaqueredirect' ? '' : await r.text();
    return { status: r.status, text };
  };
  const j = async (p) => JSON.parse((await call('GET', p)).text);
  const tasks = (await j('/tasks?include=retired')).items;
  const ids = {
    task: tasks[0].id,
    division: (await j('/divisions'))[0].id,
    team: (await j('/teams'))[0].id,
    user: (await j('/users'))[0].id,
    role: (await j('/roles'))[0].id,
  };
  const review = tasks.find((t) => t.status === 'review');
  ids.submission = review ? (await j(`/tasks/${review.id}/submissions`))[0]?.id : undefined;
  ids.template = (await j(`/divisions/${ids.division}/request-templates`))[0]?.id;
  const fill = (path) => {
    const key = path.split('/')[1].replace(/s$/, '').replace('request-template', 'template');
    return path.replace(/:[a-zA-Z]+/g, () => ids[key] ?? ids.task);
  };
  const bad = [];
  let n = 0;
  for (const r of routes.filter((r) => r.method === 'get' && !r.path.includes('stream'))) {
    n++;
    const res = await call('GET', fill(r.path));
    if (res.status >= 500 || /Prisma|Inconsistent/i.test(res.text)) bad.push(`${res.status} GET ${r.path} ${res.text.slice(0, 200)}`);
  }
  // Writes a visitor would make from the UI.
  const div = ids.division;
  const writes = [
    ['POST', '/tasks', { name: 'Sweep task', divisionId: div, template: { kind: 'default' } }],
    ['PATCH', `/tasks/${ids.task}`, { name: 'Renamed by sweep' }],
    ['POST', `/tasks/${ids.task}/claim`],
    ['POST', `/tasks/${ids.task}/leave`],
    ['POST', `/tasks/${ids.task}/messages`, { body: 'Hello from the sweep' }],
    ['POST', `/tasks/${ids.task}/retire`],
    ['POST', `/tasks/${ids.task}/revive`],
    ['POST', '/divisions', { name: 'Sweep division' }],
    ['POST', '/teams', { name: 'Sweep team', divisionId: div }],
    ['POST', '/roles', { name: 'Sweep role', kind: 'org' }],
    ['PATCH', '/settings', { orgName: 'Sweep org' }],
    ['POST', '/notifications/read-all'],
    ['POST', '/invitations', { email: 'sweep@example.com', intendedRoleIds: [] }],
  ];
  for (const [m, p, b] of writes) {
    n++;
    const res = await call(m, p, b);
    if (res.status >= 500 || /Prisma|Inconsistent/i.test(res.text)) bad.push(`${res.status} ${m} ${p} ${res.text.slice(0, 300)}`);
  }
  return { n, bad };
}, routes);

console.log(`${report.n} calls through the service worker, ${report.bad.length} failing`);
for (const b of report.bad) console.log('  ' + b);
console.log(`console errors / Prisma mentions (${logs.length}):`);
for (const l of [...new Set(logs)].slice(0, 15)) console.log('  ' + l);
await ctx.close();
