// Diagnostics: log in to a running demo API and call every GET route in the contract,
// filling `:id` params with real ids, to find routes that fail on PGlite.
//   node demo/sweep.mjs [base]   (default http://localhost:3200/api)
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3200/api';
let cookie = '';
async function req(method, path, body) {
  const csrf = /patrice_csrf=([^;]+)/.exec(cookie)?.[1];
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const name = pair.split('=')[0];
    cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(name + '=')), pair].join('; ');
  }
  const text = await r.text();
  return { status: r.status, text };
}

await req('POST', '/auth/login', { email: 'admin@example.com', password: 'correct horse battery' });
const json = async (p) => JSON.parse((await req('GET', p)).text);
const tasks = (await json('/tasks')).items;
const ids = {
  task: tasks[0].id,
  division: (await json('/divisions'))[0].id,
  team: (await json('/teams'))[0].id,
  user: (await json('/users'))[0].id,
  role: (await json('/roles'))[0].id,
};
const subs = await json(`/tasks/${tasks.find((t) => t.status === 'review')?.id ?? ids.task}/submissions`);
ids.submission = subs[0]?.id;
const tpl = await json(`/divisions/${ids.division}/request-templates`);
ids.template = tpl[0]?.id;

const routes = [...readFileSync(new URL('../src/contract/routes.ts', import.meta.url), 'utf8').matchAll(/method: 'get', path: '([^']+)'/g)].map((m) => m[1]);
const pick = (path) => {
  if (path.startsWith('/tasks/')) return ids.task;
  if (path.startsWith('/divisions/')) return ids.division;
  if (path.startsWith('/teams/')) return ids.team;
  if (path.startsWith('/users/')) return ids.user;
  if (path.startsWith('/roles/')) return ids.role;
  if (path.startsWith('/submissions/')) return ids.submission;
  if (path.startsWith('/request-templates/')) return ids.template;
  return ids.task;
};
let bad = 0;
for (const path of routes) {
  if (path.includes('stream')) continue;
  const url = path.replace(/:[a-zA-Z]+/g, () => pick(path));
  const r = await req('GET', url);
  if (r.status >= 500 || /Prisma|Inconsistent|deserializ/i.test(r.text)) {
    bad++;
    console.log(`${r.status} GET ${path}\n   ${r.text.slice(0, 300)}`);
  }
}
console.log(`${routes.length} GET routes, ${bad} failing`);
