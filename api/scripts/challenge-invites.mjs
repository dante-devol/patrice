// Invite-system challenge harness — fires adversarial traffic at a *running* API.
//
// Usage (API must be running, e.g. via the "API: Start (dev)" task):
//   node scripts/challenge-invites.mjs --password '<admin password>'
//   node scripts/challenge-invites.mjs --email admin@example.com --password 'pw' --n 25 --base http://localhost:3000
//
// This is a manual probe, not part of the test suite. It logs in as an admin,
// then runs a battery of challenges and prints what the server did. The headline
// is the race test: fire N concurrent accepts at one single-use invite and confirm
// exactly one wins.

import { argv } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = arg('--base', 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = arg('--email', 'admin@example.com');
const PASSWORD = arg('--password');
const N = Number(arg('--n', '15'));
const RUN = Math.random().toString(36).slice(2, 8); // unique suffix per run

if (!PASSWORD) {
  console.error('Missing --password <admin password>. See the header for usage.');
  process.exit(1);
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

function cookieHeader(setCookie) {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}
function csrfFrom(setCookie) {
  for (const c of setCookie) {
    const m = c.match(/patrice_csrf=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`Login failed (${res.status}). Check --email/--password.`);
  }
  const setCookie = res.headers.getSetCookie();
  return { cookie: cookieHeader(setCookie), csrf: csrfFrom(setCookie) };
}

async function createInvite(auth, body = {}) {
  const res = await fetch(`${BASE}/invitations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`createInvite failed (${res.status}): ${await res.text()}`);
  }
  return res.json(); // { id, token, url }
}

async function accept(token, email, extra = {}) {
  const res = await fetch(`${BASE}/invite/${token}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'a perfectly fine passphrase',
      displayName: 'Challenger',
      ...extra,
    }),
  });
  return res.status;
}

async function viewInvite(token) {
  const res = await fetch(`${BASE}/invite/${token}`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

async function revoke(auth, id) {
  const res = await fetch(`${BASE}/invitations/${id}/revoke`, {
    method: 'POST',
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
  });
  return res.status;
}

function tally(statuses) {
  const counts = {};
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

// ── Challenges ──────────────────────────────────────────────────────────────

async function raceTest(auth) {
  const { token } = await createInvite(auth);
  const statuses = await Promise.all(
    Array.from({ length: N }, (_, i) => accept(token, `race-${RUN}-${i}@example.com`)),
  );
  const counts = tally(statuses);
  const wins = counts[201] ?? 0;
  const pass = wins === 1;
  console.log(
    `\n[race] ${N} concurrent accepts on one single-use invite → ${JSON.stringify(counts)}`,
  );
  console.log(
    pass
      ? ok(`  PASS — exactly one 201; the rest were rejected (409 lost the atomic update, 410 read it already-exhausted).`)
      : bad(`  FAIL — expected exactly one 201, got ${wins}. Double-spend!`),
  );
}

async function raceSameEmail(auth) {
  const { token } = await createInvite(auth);
  const email = `dupe-${RUN}@example.com`;
  const statuses = await Promise.all(
    Array.from({ length: N }, () => accept(token, email)),
  );
  const counts = tally(statuses);
  const wins = counts[201] ?? 0;
  console.log(
    `\n[race-same-email] ${N} concurrent accepts, identical email → ${JSON.stringify(counts)}`,
  );
  console.log(
    wins === 1
      ? ok(`  PASS — one account created; duplicates blocked (422) or lost the race (409/410).`)
      : bad(`  FAIL — ${wins} accounts created for one email.`),
  );
}

async function noConsumeRead(auth) {
  const { token } = await createInvite(auth);
  await Promise.all(Array.from({ length: 20 }, () => viewInvite(token)));
  const after = await viewInvite(token);
  const pass = after.body?.status === 'pending';
  console.log(`\n[no-consume] 20× GET /invite/:token → status now "${after.body?.status}"`);
  console.log(pass ? ok('  PASS — reads never consume.') : bad('  FAIL — a read consumed the invite.'));
}

async function reuseAfterSuccess(auth) {
  const { token } = await createInvite(auth);
  const first = await accept(token, `reuse-${RUN}@example.com`);
  const second = await accept(token, `reuse2-${RUN}@example.com`);
  const pass = first === 201 && second === 410;
  console.log(`\n[reuse] accept twice → ${first}, then ${second}`);
  console.log(pass ? ok('  PASS — second redemption is 410 (exhausted).') : bad('  FAIL.'));
}

async function revokedThenAccept(auth) {
  const { id, token } = await createInvite(auth);
  await revoke(auth, id);
  const status = await accept(token, `revoked-${RUN}@example.com`);
  console.log(`\n[revoked] revoke, then accept → ${status}`);
  console.log(status === 410 ? ok('  PASS — 410 (revoked).') : bad(`  FAIL — expected 410, got ${status}.`));
}

async function expiredAccept(auth) {
  const { token } = await createInvite(auth, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const status = await accept(token, `expired-${RUN}@example.com`);
  console.log(`\n[expired] accept a past-expiry invite → ${status}`);
  console.log(status === 410 ? ok('  PASS — 410 (expired).') : bad(`  FAIL — expected 410, got ${status}.`));
}

async function csrfMissing(auth) {
  const res = await fetch(`${BASE}/invitations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie }, // no x-csrf-token
    body: JSON.stringify({}),
  });
  console.log(`\n[csrf] POST /invitations with cookie but no CSRF header → ${res.status}`);
  console.log(res.status === 403 ? ok('  PASS — 403 (CSRF rejected).') : bad(`  FAIL — expected 403, got ${res.status}.`));
}

async function badToken() {
  const status = (await viewInvite('this-token-does-not-exist-000000')).status;
  console.log(`\n[guess] GET an invalid token → ${status}`);
  console.log(status === 404 ? ok('  PASS — 404.') : bad(`  FAIL — expected 404, got ${status}.`));
}

// ── Run ─────────────────────────────────────────────────────────────────────

const run = async () => {
  console.log(dim(`Target: ${BASE}  ·  admin: ${EMAIL}  ·  concurrency N=${N}  ·  run=${RUN}`));
  const auth = await login();
  await raceTest(auth);
  await raceSameEmail(auth);
  await noConsumeRead(auth);
  await reuseAfterSuccess(auth);
  await revokedThenAccept(auth);
  await expiredAccept(auth);
  await csrfMissing(auth);
  await badToken();
  console.log(dim('\nDone.'));
};

run().catch((e) => {
  console.error(bad(`\nHarness error: ${e.message}`));
  process.exit(1);
});
