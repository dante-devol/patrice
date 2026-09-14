// Real-data seed — loads the Writing Division "Africa Development" localization
// sheet into a *running* Patrice API. Rows become tasks; each row's Requester and
// Claimant become individual users; the sheet's status column drives each task to
// the matching Patrice state.
//
// Like scripts/seed.mjs it talks to the HTTP API exactly like the web app does
// (cookie + CSRF, no direct DB writes), so every Cedar grant, inherent role, and
// lifecycle invariant is respected.
//
// Source sheet columns (by position — the header row is skipped):
//   0 Status  1 Country  2 Requester  3 Claimant  4 Loc Request  5 Type  6 Doc  7 Prompt
// Status → Patrice state:
//   Request → claimed · Awaiting Review → review · In-Game → approved
//
// Usage (API must be running — `cd api && npm run start:dev`):
//   Fresh instance (bootstrap still open):  npm run seed:loc -- --key <bootstrap-key>
//   Already bootstrapped:                   npm run seed:loc -- --password '<admin pw>'
//
// Flags: --base (default http://localhost:3000/api) · --key <bootstrap key>
//        --email (default admin@example.com) · --password (default 'correct horse battery')
//        --csv (default the Downloads sheet) · --division (default Writing) · --team (default Africa Development)
//
// Idempotent for roles/division/team/users. Tasks are additive — each run appends
// the sheet again; reset the DB for a clean slate.

import { argv } from 'node:process';
import { readFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = arg('--base', 'http://localhost:3000/api').replace(/\/$/, '');
const KEY = arg('--key', null);
const ADMIN_EMAIL = arg('--email', 'admin@example.com');
const PASSWORD = arg('--password', 'correct horse battery');
const CSV_PATH = arg(
  '--csv',
  'C:\\Users\\dante\\Downloads\\Debrouillez-Vous Loc Sheet ✍️ - General_Other.csv',
);
const DIVISION_NAME = arg('--division', 'Writing');
const TEAM_NAME = arg('--team', 'Africa Development');

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};
const log = (s) => console.log(s);
const step = (s) => console.log(c.dim(`\n▸ ${s}`));

// ── HTTP plumbing (cookie + CSRF, like the SPA) ──────────────────────────────

function sessionFrom(setCookie) {
  const cookie = setCookie.map((x) => x.split(';')[0]).join('; ');
  let csrf = null;
  for (const x of setCookie) {
    const m = x.match(/patrice_csrf=([^;]+)/);
    if (m) csrf = decodeURIComponent(m[1]);
  }
  return { cookie, csrf };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, { session, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) {
    headers.cookie = session.cookie;
    if (session.csrf) headers['x-csrf-token'] = session.csrf;
  }
  // The API rate-limits credential routes (login 10/min, invite-accept 10/min) and
  // caps the instance at 300 req/min. Rather than race the limiter, respect it: on a
  // 429 we wait out the throttler's Retry-After (seconds) and retry, so an auth-heavy
  // seed just paces itself instead of failing.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 20) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000;
      log(c.dim(`  throttled on ${method} ${path} — waiting ${Math.ceil(waitMs / 1000)}s`));
      await sleep(waitMs + 250);
      continue;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, setCookie: res.headers.getSetCookie() };
  }
}

const ok = (r) => r.status >= 200 && r.status < 300;
function must(r, what) {
  if (!ok(r)) {
    throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  must(r, `login ${email}`);
  return sessionFrom(r.setCookie);
}

// ── Minimal RFC-4180 CSV parser (handles quoted, comma- and newline-bearing fields) ──

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // swallow; the paired \n ends the record
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const STATE_BY_STATUS = {
  request: 'claimed',
  'awaiting review': 'review',
  'in-game': 'approved',
};

function slugEmail(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'user';
  return `${slug}@example.com`;
}

// ── Idempotent ensure-helpers ────────────────────────────────────────────────

let admin; // { cookie, csrf }
let adminUserId;
let existingGrants = new Set(); // `${roleId}|${action}|${scopeKind}`

async function getAdminSession() {
  const status = must(await req('GET', '/bootstrap'), 'GET /bootstrap');
  if (status.open) {
    if (!KEY) {
      throw new Error(
        'This instance still needs bootstrapping. Pass the key the API printed at ' +
          'startup:  npm run seed:loc -- --key <bootstrap-key>',
      );
    }
    const r = await req('POST', `/invite/${status.inviteToken}/accept`, {
      body: { passcode: KEY, email: ADMIN_EMAIL, password: PASSWORD, displayName: 'Admin' },
    });
    must(r, 'bootstrap accept');
    log(c.ok(`  bootstrapped admin ${ADMIN_EMAIL}`));
    return sessionFrom(r.setCookie);
  }
  log(c.dim(`  already bootstrapped — logging in as ${ADMIN_EMAIL}`));
  const r = await req('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: PASSWORD } });
  if (r.status === 401) {
    throw new Error(
      `Admin login was rejected for ${ADMIN_EMAIL}. This instance is already set up with ` +
        `different credentials — pass them:  npm run seed:loc -- --email <you@org> --password '<pw>'`,
    );
  }
  must(r, `login ${ADMIN_EMAIL}`);
  return sessionFrom(r.setCookie);
}

async function ensureRole(name) {
  const roles = must(await req('GET', '/roles', { session: admin }), 'GET /roles');
  const found = roles.find((r) => r.name === name && r.lifecycleState === 'active');
  if (found) return found.id;
  const created = must(
    await req('POST', '/roles', { session: admin, body: { name } }),
    `create role ${name}`,
  );
  return created.id;
}

async function ensureDivision(name) {
  const divs = must(await req('GET', '/divisions', { session: admin }), 'GET /divisions');
  const found = divs.find((d) => d.name === name && d.lifecycleState === 'active');
  if (found) return found;
  return must(
    await req('POST', '/divisions', { session: admin, body: { name } }),
    `create division ${name}`,
  );
}

async function ensureTeam(name) {
  const teams = must(await req('GET', '/teams', { session: admin }), 'GET /teams');
  const found = teams.find((t) => t.name === name && t.lifecycleState === 'active');
  if (found) return found;
  return must(
    await req('POST', '/teams', { session: admin, body: { name } }),
    `create team ${name}`,
  );
}

async function grant(roleId, action, scopeKind) {
  const sig = `${roleId}|${action}|${scopeKind}`;
  if (existingGrants.has(sig)) return;
  const r = await req('POST', '/grants', { session: admin, body: { roleId, action, scopeKind } });
  if (ok(r)) existingGrants.add(sig);
  else log(c.warn(`  grant ${action}/${scopeKind} → ${r.status} (skipped)`));
}

async function setLinkRequestTemplate(divisionId) {
  // A single "Document link" text question — claimants submit the link to their
  // finished loc doc. Non-destructive: only set it when the division has no
  // request template yet, so re-runs never clobber an existing form.
  const existing = await req('GET', `/divisions/${divisionId}/request-template`, { session: admin });
  if (existing.status === 200 && (existing.data?.questions?.length ?? 0) > 0) return;
  await req('PUT', `/divisions/${divisionId}/request-template`, {
    session: admin,
    body: {
      questions: [
        { type: 'text', prompt: 'Document link', required: false, constraints: {} },
      ],
    },
  });
}

async function ensureUser({ email, displayName, roleIds }) {
  const inv = await req('POST', '/invitations', {
    session: admin,
    body: { email, intendedRoleIds: roleIds },
  });
  if (ok(inv)) {
    const acc = await req('POST', `/invite/${inv.data.token}/accept`, {
      body: { email, password: PASSWORD, displayName },
    });
    if (ok(acc)) {
      log(c.ok(`  + ${displayName} <${email}>`));
      return { userId: acc.data.id, name: displayName, session: sessionFrom(acc.setCookie) };
    }
  }
  // Email already taken (re-run) → just log in with the shared dev password.
  const session = await login(email, PASSWORD);
  const me = must(await req('GET', '/me', { session }), `whoami ${email}`);
  log(c.dim(`  = ${displayName} <${email}> (existing)`));
  return { userId: me.id, name: displayName, session };
}

// ── Task driving ─────────────────────────────────────────────────────────────

async function driveTask(spec, ctx) {
  const { division, teamId, users, questionId } = ctx;

  const task = must(
    await req('POST', '/tasks', {
      session: admin,
      body: { name: spec.name, description: spec.description, divisionId: division.id, teamId },
    }),
    `create task ${spec.name}`,
  );

  const requester = users[spec.requester];
  if (requester && requester.userId !== adminUserId) {
    await req('POST', `/tasks/${task.id}/requester`, { session: admin, body: { userId: requester.userId } });
  }

  const claimant = users[spec.claimant];
  if (claimant) {
    const r = await req('POST', `/tasks/${task.id}/claim`, { session: claimant.session });
    if (!ok(r)) log(c.warn(`    claim by ${claimant.name} → ${r.status}`));
  }

  const submits = spec.state === 'review' || spec.state === 'approved';
  if (submits && claimant) {
    const value = spec.link || `Deliverable from ${claimant.name}.`;
    const r = await req('POST', `/tasks/${task.id}/submissions`, {
      session: claimant.session,
      body: { answers: questionId ? [{ questionId, value }] : [] },
    });
    if (!ok(r)) log(c.warn(`    submit by ${claimant.name} → ${r.status}`));
  }

  if (spec.state === 'approved') {
    const subs = must(await req('GET', `/tasks/${task.id}/submissions`, { session: admin }), 'list submissions');
    for (const s of subs) {
      await req('POST', `/submissions/${s.id}/review`, {
        session: admin,
        body: { decision: 'approve', comment: 'In-game — approved.' },
      });
    }
  }

  log(`  ${c.ok('✓')} ${spec.name} ${c.dim(`[${spec.state}]`)}`);
}

// ── Run ──────────────────────────────────────────────────────────────────────

const run = async () => {
  log(c.dim(`Target: ${BASE}`));
  log(c.dim(`Sheet:  ${CSV_PATH}`));

  step('Parsing sheet');
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const dataRows = rows.slice(1).filter((r) => r.some((cell) => (cell ?? '').trim() !== ''));
  const specs = [];
  const skipped = [];
  for (const r of dataRows) {
    const status = (r[0] ?? '').trim().toLowerCase();
    const country = (r[1] ?? '').trim();
    const requester = (r[2] ?? '').trim();
    const claimant = (r[3] ?? '').trim();
    const title = (r[4] ?? '').trim();
    const doc = (r[6] ?? '').trim();
    const prompt = (r[7] ?? '').trim();
    const state = STATE_BY_STATUS[status];
    if (!state || !title) {
      skipped.push(r);
      continue;
    }
    const description =
      country && country !== '-' ? `[${country}] ${prompt}` : prompt;
    const link = /^https?:\/\//i.test(doc) ? doc : '';
    specs.push({ name: title, description, requester, claimant, state, link });
  }
  log(c.ok(`  ${specs.length} tasks`) + c.dim(` (${skipped.length} rows skipped)`));

  step('Authenticating');
  admin = await getAdminSession();
  adminUserId = must(await req('GET', '/me', { session: admin }), 'GET /me').id;

  step('Permissions');
  const usersList = must(await req('GET', '/users', { session: admin }), 'GET /users');
  const adminRecord = usersList.find((u) => u.email === ADMIN_EMAIL);
  const adminRoleId = adminRecord?.roleIds?.[0];
  if (!adminRoleId) throw new Error('Could not resolve the admin role to attach grants to.');

  existingGrants = new Set(
    must(await req('GET', '/grants', { session: admin }), 'GET /grants').map(
      (g) => `${g.roleId}|${g.action}|${g.scopeKind}`,
    ),
  );
  for (const action of [
    'task:create', 'task:assign', 'task:submit', 'task:review', 'task:complete',
    'task:manage_claims', 'task:change_requester', 'task:configure_request_template',
  ]) {
    await grant(adminRoleId, action, 'global');
  }
  const memberRoleId = await ensureRole('Member');
  await grant(memberRoleId, 'task:assign', 'own');
  await grant(memberRoleId, 'task:submit', 'own');
  log(c.ok('  grants in place (admin global · Member self-claim/submit)'));

  step(`Division + request template (${DIVISION_NAME})`);
  const division = await ensureDivision(DIVISION_NAME);
  await setLinkRequestTemplate(division.id);
  const qn = must(
    await req('GET', `/divisions/${division.id}/request-template`, { session: admin }),
    'get division request template',
  );
  const questionId = qn?.questions?.[0]?.id;
  log(c.ok(`  ${DIVISION_NAME}`));

  step(`Team (${TEAM_NAME})`);
  const team = await ensureTeam(TEAM_NAME);
  log(c.ok(`  ${TEAM_NAME}`));

  step('Users');
  const names = new Set();
  for (const s of specs) {
    if (s.requester) names.add(s.requester);
    if (s.claimant) names.add(s.claimant);
  }
  const users = {};
  for (const name of names) {
    users[name] = await ensureUser({
      email: slugEmail(name),
      displayName: name,
      roleIds: [memberRoleId],
    });
  }

  step('Tasks');
  for (const spec of specs) {
    await driveTask(spec, { division, teamId: team.id, users, questionId });
  }

  log(c.ok('\n✓ Seed complete.'));
  log(c.dim(`  Admin login: ${ADMIN_EMAIL} / ${PASSWORD}`));
  log(c.dim(`  ${names.size} sheet users (same password): e.g. ${[...names].slice(0, 3).map(slugEmail).join(', ')}`));
  log(c.dim('  Open the web app and visit /tasks.'));
};

run().catch((e) => {
  console.error(c.bad(`\nSeed failed: ${e.message}`));
  process.exitCode = 1;
});
