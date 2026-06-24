// Dev seed — loads a realistic working set (roles, divisions, teams, users,
// permissions, and tasks across every status) into a *running* Patrice API, so you
// don't have to click through bootstrap → grants → invites → task setup by hand.
//
// It talks to the HTTP API exactly like the web app does, so every Cedar grant,
// inherent role, and lifecycle invariant is respected (no direct DB writes).
//
// Usage (API must be running — `cd api && npm run start:dev`):
//   First run on a fresh instance (bootstrap still open): pass the key the API
//   printed at startup ("PATRICE BOOTSTRAP KEY: …"):
//     npm run seed -- --key <bootstrap-key>
//   Already bootstrapped: it logs in as the admin instead (defaults below):
//     npm run seed -- --password 'correct horse battery'
//
// Flags: --base (default http://localhost:3000/api) · --key <bootstrap key>
//        --email (default admin@example.com) · --password (default 'correct horse battery')
//
// Idempotent for roles/divisions/teams/users/grants (reused by name/email). Tasks are
// additive — each run appends the demo set; reset the DB for a clean slate.

import { argv } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = arg('--base', 'http://localhost:3000/api').replace(/\/$/, '');
const KEY = arg('--key', null);
const ADMIN_EMAIL = arg('--email', 'admin@example.com');
const PASSWORD = arg('--password', 'correct horse battery');

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

async function req(method, path, { session, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) {
    headers.cookie = session.cookie;
    if (session.csrf) headers['x-csrf-token'] = session.csrf;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, setCookie: res.headers.getSetCookie() };
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

// ── Auth: bootstrap the first admin, or log in if already set up ─────────────

async function getAdminSession() {
  const status = must(await req('GET', '/bootstrap'), 'GET /bootstrap');
  if (status.open) {
    if (!KEY) {
      throw new Error(
        'This instance still needs bootstrapping. Pass the key the API printed at ' +
          'startup:  npm run seed -- --key <bootstrap-key>',
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
        `different credentials — pass them:  npm run seed -- --email <you@org> --password '<pw>'`,
    );
  }
  must(r, `login ${ADMIN_EMAIL}`);
  return sessionFrom(r.setCookie);
}

// ── Idempotent ensure-helpers ────────────────────────────────────────────────

let admin; // { cookie, csrf }
let adminUserId;
let existingGrants = new Set(); // `${roleId}|${action}|${scopeKind}`

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

async function ensureDivision(name, opts = {}) {
  const divs = must(await req('GET', '/divisions', { session: admin }), 'GET /divisions');
  const found = divs.find((d) => d.name === name && d.lifecycleState === 'active');
  if (found) return found;
  return must(
    await req('POST', '/divisions', { session: admin, body: { name, ...opts } }),
    `create division ${name}`,
  );
}

async function ensureTeam(name, opts = {}) {
  const teams = must(await req('GET', '/teams', { session: admin }), 'GET /teams');
  const found = teams.find((t) => t.name === name && t.lifecycleState === 'active');
  if (found) return found;
  return must(
    await req('POST', '/teams', { session: admin, body: { name, ...opts } }),
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

async function setQuestionnaire(divisionId) {
  // A single free-text question so claimants have something to submit against.
  // Non-destructive: only set it when the division has no questionnaire yet, so
  // re-runs (or seeding an instance with real config) never clobber existing forms.
  const existing = await req('GET', `/divisions/${divisionId}/questionnaire`, { session: admin });
  if (existing.status === 200 && (existing.data?.questions?.length ?? 0) > 0) return;
  await req('PUT', `/divisions/${divisionId}/questionnaire`, {
    session: admin,
    body: { questions: [{ type: 'text', prompt: 'Deliverable notes', required: false, constraints: {} }] },
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
  const { divisions, teams, users } = ctx;
  const division = divisions[spec.division];
  const teamId = spec.team ? teams[spec.team].id : undefined;

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

  const claimants = (spec.claimants ?? []).map((k) => users[k]);
  if (claimants.length > 1) {
    await req('POST', `/tasks/${task.id}/claims`, { session: admin, body: { openingsDelta: claimants.length - 1 } });
  }
  for (const u of claimants) {
    const r = await req('POST', `/tasks/${task.id}/claim`, { session: u.session });
    if (!ok(r)) log(c.warn(`    claim by ${u.name} → ${r.status}`));
  }

  const submits = ['review', 'revising', 'approved'].includes(spec.state);
  if (submits) {
    const qn = must(await req('GET', `/tasks/${task.id}/questionnaire`, { session: admin }), 'get task questionnaire');
    const questionId = qn?.questions?.[0]?.id;
    for (const u of claimants) {
      const r = await req('POST', `/tasks/${task.id}/submissions`, {
        session: u.session,
        body: { answers: questionId ? [{ questionId, value: `Seed deliverable from ${u.name}.` }] : [] },
      });
      if (!ok(r)) log(c.warn(`    submit by ${u.name} → ${r.status}`));
    }
  }

  if (spec.state === 'revising' || spec.state === 'approved') {
    const subs = must(await req('GET', `/tasks/${task.id}/submissions`, { session: admin }), 'list submissions');
    const decision = spec.state === 'approved' ? 'approve' : 'return';
    for (const s of subs) {
      await req('POST', `/submissions/${s.id}/review`, {
        session: admin,
        body: { decision, comment: decision === 'return' ? 'Close, but needs another pass.' : 'Looks good — approved.' },
      });
      if (spec.state === 'revising') break; // one return is enough to move the task to revising
    }
  }

  log(`  ${c.ok('✓')} ${spec.name} ${c.dim(`[${spec.state}]`)}`);
}

// ── Run ──────────────────────────────────────────────────────────────────────

const run = async () => {
  log(c.dim(`Target: ${BASE}`));

  step('Authenticating');
  admin = await getAdminSession();
  adminUserId = must(await req('GET', '/me', { session: admin }), 'GET /me').id;

  step('Permissions');
  // The bootstrap admin can manage the org but isn't granted task authorities by
  // default — add the global ones it needs to build and review the working set.
  const me = must(await req('GET', '/users', { session: admin }), 'GET /users');
  const adminRecord = me.find((u) => u.email === ADMIN_EMAIL);
  const adminRoleId = adminRecord?.roleIds?.[0];
  if (!adminRoleId) throw new Error('Could not resolve the admin role to attach grants to.');

  existingGrants = new Set(
    must(await req('GET', '/grants', { session: admin }), 'GET /grants').map(
      (g) => `${g.roleId}|${g.action}|${g.scopeKind}`,
    ),
  );
  for (const action of [
    'task:create', 'task:assign', 'task:submit', 'task:review', 'task:complete',
    'task:manage_claims', 'task:change_requester', 'task:configure_questionnaire',
  ]) {
    await grant(adminRoleId, action, 'global');
  }
  // A "Member" role anyone can hold to self-claim and submit their own work.
  const memberRoleId = await ensureRole('Member');
  await grant(memberRoleId, 'task:assign', 'own');
  await grant(memberRoleId, 'task:submit', 'own');
  log(c.ok('  grants in place (admin global · Member self-claim/submit)'));

  step('Divisions + questionnaires');
  const divisionNames = ['Writing', 'Art', 'Scripting', 'Testing', 'Leadership'];
  const divisions = {};
  for (const name of divisionNames) {
    const d = await ensureDivision(name);
    await setQuestionnaire(d.id);
    divisions[name] = d;
    log(c.ok(`  ${name}`));
  }

  step('Teams');
  const teams = {};
  for (const name of ['USA', 'Artists']) {
    teams[name] = await ensureTeam(name);
    log(c.ok(`  ${name}`));
  }

  step('Users');
  const users = {};
  const people = [
    { key: 'Devin', email: 'devin@example.com' },
    { key: 'Maya', email: 'maya@example.com' },
    { key: 'Aric', email: 'aric@example.com' },
    { key: 'Sela', email: 'sela@example.com' },
    { key: 'Joon', email: 'joon@example.com' },
  ];
  for (const p of people) {
    users[p.key] = await ensureUser({ email: p.email, displayName: p.key, roleIds: [memberRoleId] });
  }

  step('Tasks (every status)');
  const taskSpecs = [
    { name: 'Tavern interior — concept sheet', division: 'Art', requester: 'Sela', state: 'open',
      description: 'Three mood frames for the riverside tavern — warm lamplight, late evening. PNG, 2K wide.' },
    { name: 'Localize Chapter 3 — tavern dialogue', division: 'Writing', team: 'USA', requester: 'Devin',
      state: 'review', claimants: ['Maya', 'Aric'],
      description: 'Pass over the 40 tavern barks; keep cadence loose and in-character. Two translators on it.' },
    { name: 'Port save-system to the v2 schema', division: 'Scripting', requester: 'Joon', state: 'revising',
      claimants: ['Maya'], description: 'Migrate legacy save blobs; needs the backwards-compat shim.' },
    { name: 'Regression pass — Act I quest flags', division: 'Testing', team: 'USA', requester: 'Sela',
      state: 'claimed', claimants: ['Aric'],
      description: 'Walk every Act I branch; confirm flags clear on completion.' },
    { name: 'Sign off Act I voice direction', division: 'Leadership', requester: 'Devin', state: 'approved',
      claimants: ['Maya'], description: 'Final review of the Act I VO brief before recording opens.' },
    { name: 'Write merchant barks — 20 lines', division: 'Writing', requester: 'Maya', state: 'open',
      description: 'Short, repeatable merchant lines for the market district. Two writers welcome.' },
    { name: 'Balance pass — boss encounters', division: 'Scripting', requester: 'Aric', state: 'review',
      claimants: ['Joon'], description: 'Tune the three Act I bosses; log any spikes.' },
  ];
  for (const spec of taskSpecs) {
    await driveTask(spec, { divisions, teams, users });
  }

  log(c.ok('\n✓ Seed complete.'));
  log(c.dim(`  Admin login: ${ADMIN_EMAIL} / ${PASSWORD}`));
  log(c.dim(`  Demo users (same password): ${people.map((p) => p.email).join(', ')}`));
  log(c.dim('  Open the web app and visit /tasks.'));
};

run().catch((e) => {
  console.error(c.bad(`\nSeed failed: ${e.message}`));
  process.exitCode = 1;
});
