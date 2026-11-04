// Cutover check: snapshot an instance before and after migrating, then compare.
//
// Records, as JSON: row counts per entity, each task's status, and — signing in as
// each listed user through the running API — which tasks that user can see. Run it
// against the old version, migrate, run it against the new one, then diff:
//
//   node scripts/cutover-snapshot.mjs --base http://localhost:3000/api --out before.json \
//     --users admin@example.com,devin@example.com --password '…'
//   (migrate, start the new version)
//   node scripts/cutover-snapshot.mjs --base … --out after.json --users … --password '…'
//   node scripts/cutover-snapshot.mjs --compare before.json after.json
//
// DATABASE_URL must point at the instance's database. Reads only.

import { argv, env, exit } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** Entities to count; each is a SQL count that works on both sides of the cutover. */
const COUNTS = {
  users: `SELECT count(*) FROM app_user`,
  roles: `SELECT count(*) FROM role`,
  grants: `SELECT count(*) FROM "grant"`,
  user_roles: `SELECT count(*) FROM user_role`,
  divisions: `SELECT count(*) FROM division`,
  teams: `SELECT count(*) FROM team`,
  tasks: `SELECT count(*) FROM task`,
  claimant_seats: `SELECT count(*) FROM task_claimant WHERE left_at IS NULL`,
  submissions: `SELECT count(*) FROM submission`,
  answers: `SELECT count(*) FROM answer`,
  attachments: `SELECT count(*) FROM attachment`,
  // Before: every message row. After: comments plus timeline events (system messages
  // became events), so this is compared as a sum.
  messages: `SELECT count(*) FROM message`,
  domain_events: `SELECT count(*) FROM domain_event`,
  notifications: `SELECT count(*) FROM notification`,
  integration_connections: `SELECT count(*) FROM integration_connection`,
};

async function counts(db) {
  const out = {};
  for (const [k, sql] of Object.entries(COUNTS)) {
    try {
      out[k] = Number(Object.values((await db.query(sql)).rows[0])[0]);
    } catch (e) {
      if (e.code !== '42P01') throw e; // a table this version doesn't have yet
      out[k] = 0;
    }
  }
  return out;
}

async function statuses(db) {
  const rows = (await db.query(`SELECT id, name, status_cache FROM task ORDER BY name`)).rows;
  return Object.fromEntries(rows.map((r) => [r.name, r.status_cache]));
}

async function signIn(base, email, password) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** The names of the tasks a user can see, via the API's own list. */
async function visibleTasks(base, cookie) {
  const names = [];
  let after;
  for (;;) {
    const q = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
    const res = await fetch(`${base}/tasks?${q}`, { headers: { cookie } });
    if (!res.ok) return { error: res.status };
    const page = await res.json();
    names.push(...page.items.map((t) => t.name));
    if (!page.nextCursor) return names.sort();
    after = page.nextCursor;
  }
}

async function snapshot() {
  const base = arg('--base', 'http://localhost:3000/api').replace(/\/$/, '');
  const users = arg('--users', 'admin@example.com').split(',');
  const password = arg('--password', 'correct horse battery');
  const db = new pg.Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  try {
    const access = {};
    for (const email of users) {
      const cookie = await signIn(base, email, password);
      access[email] = cookie ? await visibleTasks(base, cookie) : { error: 'sign-in failed' };
    }
    const snap = { counts: await counts(db), statuses: await statuses(db), access };
    writeFileSync(arg('--out', 'snapshot.json'), JSON.stringify(snap, null, 2));
    console.log(JSON.stringify(snap.counts));
  } finally {
    await db.end();
  }
}

function compare(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const lines = [];
  lines.push('## Counts', '| entity | before | after |', '|---|---|---|');
  for (const k of Object.keys(before.counts)) {
    const mark = before.counts[k] === after.counts[k] ? '' : ' ⚠';
    lines.push(`| ${k} | ${before.counts[k]} | ${after.counts[k]}${mark} |`);
  }
  lines.push('', '## Task statuses', '| task | before | after |', '|---|---|---|');
  for (const name of Object.keys(before.statuses)) {
    const mark = before.statuses[name] === after.statuses[name] ? '' : ' ⚠';
    lines.push(`| ${name} | ${before.statuses[name]} | ${after.statuses[name]}${mark} |`);
  }
  lines.push('', '## Tasks each user can see');
  for (const email of Object.keys(before.access)) {
    const b = before.access[email];
    const a = after.access[email];
    const bs = new Set(Array.isArray(b) ? b : []);
    const as = new Set(Array.isArray(a) ? a : []);
    const lost = [...bs].filter((x) => !as.has(x));
    const gained = [...as].filter((x) => !bs.has(x));
    lines.push(`- **${email}**: ${Array.isArray(b) ? b.length : JSON.stringify(b)} → ${Array.isArray(a) ? a.length : JSON.stringify(a)}` +
      (lost.length ? `; no longer sees: ${lost.join(', ')}` : '') +
      (gained.length ? `; now sees: ${gained.join(', ')}` : ''));
  }
  console.log(lines.join('\n'));
}

if (argv.includes('--compare')) {
  const i = argv.indexOf('--compare');
  compare(argv[i + 1], argv[i + 2]);
} else {
  snapshot().catch((e) => {
    console.error(e);
    exit(1);
  });
}
