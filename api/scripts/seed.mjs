// Dev + demo seed — loads a realistic working organisation into a *running* Patrice
// API: four divisions, eight teams, 50 members with team and division memberships and
// project leads, and ~500 tasks spread across every status, with submissions, reviews
// and thread messages. The browser demo's snapshot is built from this script too
// (demo/src/node-server.ts), and the demo start page reads its admin login from here.
//
// It talks to the HTTP API exactly like the web app does, so every Cedar grant,
// inherent role, and lifecycle invariant is respected (no direct DB writes). Each task
// is created and run by its requester's own session, the way a member would.
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
//        --tasks <n> (default 500) · --append (add tasks even when some already exist)
//
// Idempotent for roles/divisions/teams/users/memberships/leads (reused by name/email).
// Tasks are only created when the instance has none, unless --append is passed.
// The data is generated from a fixed random seed, so every fresh run is identical.
//
// The API rate-limits requests (300/min overall, 10/min on login and invite-accept).
// Against a dev server this seed waits out each 429 and carries on, so a first run
// takes several minutes; the demo build lifts the limit while it seeds.

import { argv } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const BASE = arg('--base', 'http://localhost:3000/api').replace(/\/$/, '');
const KEY = arg('--key', null);
const ADMIN_EMAIL = arg('--email', 'admin@example.com');
const PASSWORD = arg('--password', 'correct horse battery');
const ADMIN_NAME = 'Admin Adam';
const TASK_COUNT = Number(arg('--tasks', '500'));
const APPEND = argv.includes('--append');

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};
const log = (s) => console.log(s);
const step = (s) => console.log(c.dim(`\n▸ ${s}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Deterministic randomness ─────────────────────────────────────────────────

// mulberry32: a tiny seeded PRNG, so the generated org is the same on every run.
let rngState = 0x5eed2026;
function rand() {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
function sample(xs, n) {
  const pool = [...xs];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) if ((r -= w) < 0) return v;
  return entries[entries.length - 1][0];
}

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

let requestCount = 0;
async function req(method, path, { session, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) {
    headers.cookie = session.cookie;
    if (session.csrf) headers['x-csrf-token'] = session.csrf;
  }
  // On a 429, wait out the throttler's Retry-After (seconds) and try again.
  for (let attempt = 0; ; attempt++) {
    requestCount++;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 30) {
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
let warnings = 0;
function soft(r, what) {
  if (!ok(r)) {
    warnings++;
    log(c.warn(`    ${what} → ${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`));
  }
  return ok(r) ? r.data : null;
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
      body: { passcode: KEY, email: ADMIN_EMAIL, password: PASSWORD, displayName: ADMIN_NAME },
    });
    must(r, 'bootstrap accept');
    log(c.ok(`  bootstrapped ${ADMIN_NAME} <${ADMIN_EMAIL}>`));
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

// ── The organisation ─────────────────────────────────────────────────────────

const DIVISIONS = ['Writing', 'Coding', 'Testing', 'Art'];

const COUNTRIES = [
  { name: 'United States', lang: 'English', people: ['Avery Brooks', 'Jordan Hayes', 'Marcus Bell', 'Tyler Reed', 'Grace Whitman', 'Maya Collins', 'Hannah Price'] },
  { name: 'Germany', lang: 'German', people: ['Lukas Becker', 'Felix Wagner', 'Jonas Richter', 'Tobias Klein', 'Anna Schmidt', 'Lena Hoffmann', 'Mia Schulz'] },
  { name: 'Italy', lang: 'Italian', people: ['Giulia Romano', 'Marco Ricci', 'Luca Bianchi', 'Matteo Greco', 'Chiara Conti', 'Sofia Esposito', 'Elena Marino'] },
  { name: 'Japan', lang: 'Japanese', people: ['Haruto Sato', 'Ren Suzuki', 'Sota Ito', 'Kaito Yamamoto', 'Yui Tanaka', 'Aoi Takahashi', 'Hina Watanabe'] },
  { name: 'China', lang: 'Simplified Chinese', people: ['Wei Zhang', 'Chen Hao', 'Liu Yang', 'Sun Lei', 'Li Na', 'Wang Fang', 'Zhao Min'] },
];
const ARTISTS = ['Isla Moreno', 'Theo Laurent', 'Priya Nair', 'Oscar Lindqvist', 'Nadia Petrova', 'Diego Alvarez', 'Freya Olsen', 'Kenji Mori', 'Amara Okafor', 'Rosa Delgado'];
const TESTERS = ['Sam Patel', 'Noor Haddad', 'Ethan Clarke', 'Zoe Kim', 'Omar Farouk'];

/**
 * Who belongs where. A team supports one division, several, or all of them; a member
 * of a single-division team is always a member of that division too (derived below).
 * The other divisions people are in are listed with them.
 *  - Each country has one team serving Coding and Writing, and 7 people: [0] works in
 *    both divisions and leads the team; [1–3] code; [4–6] write. [3] also tests.
 *  - Artists: [0–4] 3D Art, [4–9] Portrait Art ([4] on both); [0] leads Art. Both
 *    teams serve Art alone.
 *  - Testers sit in Testing, and form Playtest, a team serving every division; [0]
 *    leads Testing and Playtest, and also helps in Coding.
 */
function buildPeople() {
  const people = [];
  const add = (name, teams, divisions = [], leads = []) =>
    people.push({ name, email: emailFor(name), teams, divisions, leads });
  for (const country of COUNTRIES) {
    const [lead, c1, c2, c3, w1, w2, w3] = country.people;
    add(lead, [country.name], ['Coding', 'Writing'], [{ team: country.name }]);
    for (const n of [c1, c2]) add(n, [country.name], ['Coding']);
    add(c3, [country.name], ['Coding', 'Testing']);
    for (const n of [w1, w2, w3]) add(n, [country.name], ['Writing']);
  }
  ARTISTS.forEach((n, i) => {
    const teams = i < 4 ? ['3D Art'] : i === 4 ? ['3D Art', 'Portrait Art'] : ['Portrait Art'];
    add(n, teams, [], i === 0 ? [{ division: 'Art' }] : []);
  });
  TESTERS.forEach((n, i) => {
    add(
      n,
      [PLAYTEST],
      i === 0 ? ['Testing', 'Coding'] : ['Testing'],
      i === 0 ? [{ division: 'Testing' }, { team: PLAYTEST }] : [],
    );
  });
  return people;
}

/** The divisions a person is in: the ones listed, plus each single-division team's. */
function divisionsOf(p) {
  const out = new Set(p.divisions);
  for (const tn of p.teams) {
    const t = TEAMS.find((x) => x.name === tn);
    if (t.divisions?.length === 1) out.add(t.divisions[0]);
  }
  return out;
}

function emailFor(name) {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`;
}

const PLAYTEST = 'Playtest';

/** The three shapes: a team per country serving two divisions, two Art-only teams, and one serving all. */
const TEAMS = [
  ...COUNTRIES.map((ct) => ({ name: ct.name, divisions: ['Coding', 'Writing'], country: ct })),
  { name: '3D Art', divisions: ['Art'], kind: '3d' },
  { name: 'Portrait Art', divisions: ['Art'], kind: 'portrait' },
  { name: PLAYTEST, all: true },
];

// ── Task content ─────────────────────────────────────────────────────────────

const WRITING_AREAS = [
  'tavern dialogue', 'merchant barks', 'quest log entries', 'item descriptions', 'tutorial prompts',
  'achievement text', 'codex entries', 'loading screen tips', 'companion banter', 'boss intro lines',
  'settings menu strings', 'letters and notes', 'store page copy', 'ferry crossing scene',
  'blacksmith side quest', 'harvest festival event', 'epilogue narration', 'bestiary pages',
  'map labels', 'credits roll', 'patch notes', 'onboarding emails', 'trailer subtitles',
];
const SOURCE_WRITING = ['Draft', 'Edit', 'Copy pass on', 'Tighten', 'Write'];
const LOC_WRITING = ['Localize', 'Proofread', 'Translate', 'Glossary pass on', 'Cultural review of'];

const CODE_COMPONENTS = [
  'save system', 'inventory UI', 'dialogue engine', 'pathfinding', 'audio mixer', 'quest tracker',
  'localization loader', 'input remapping', 'shader cache', 'achievement sync', 'crash reporter',
  'mod loader', 'minimap', 'photo mode', 'controller haptics', 'cloud saves', 'asset streaming',
  'subtitle renderer', 'font atlas builder', 'settings persistence', 'build pipeline', 'telemetry batching',
];
const CODE_VERBS = ['Fix', 'Implement', 'Refactor', 'Port', 'Profile', 'Add tests for', 'Optimize', 'Document'];
const COUNTRY_CODE = {
  'United States': ['ESRB rating screen', 'US English spellcheck hook', 'imperial units toggle'],
  Germany: ['USK rating screen', 'long-word UI wrapping', 'decimal comma formatting'],
  Italy: ['PEGI notice screen', 'accented glyph fallback', 'date format (dd/mm)'],
  Japan: ['IME text input', 'vertical text layout', 'kinsoku line breaking'],
  China: ['CJK font fallback', 'pinyin name sorting', 'anti-addiction timer'],
};

const PLACES = [
  'riverside tavern', 'market district', 'blacksmith forge', 'castle gate', 'ferry landing',
  'old lighthouse', 'monastery library', 'mill wheel', 'harbour cranes', 'watchtower',
  'herbalist hut', 'canal bridge', 'throne room', 'mine entrance', 'orchard', 'wagon camp',
];
const MODELING = ['Model', 'Retopologize', 'Texture', 'Sculpt', 'LOD pass on', 'Rig', 'Lighting pass on'];
const CHARACTERS = [
  'Captain Mirela', 'Old Tomas', 'the Archivist', 'Brother Hale', 'Sela the Ferrywoman', 'Duke Arven',
  'Ines the Smith', 'young Pell', 'the Lamplighter', 'Mother Odile', 'Corporal Brandt', 'the Fen Witch',
  'Rook the Fence', 'Lady Veyra', 'Grandmother Ash', 'the Toll Keeper',
];
const PORTRAIT = ['Portrait of', 'Expression sheet for', 'Bust sketch of', 'Final render of', 'Costume turnaround for'];
const CONCEPT = ['Concept sheet', 'Mood frames', 'Colour script', 'Prop sheet'];

const TEST_KINDS = ['Regression pass', 'Smoke test', 'Exploratory session', 'Compatibility check', 'Certification checklist', 'Performance capture'];
const TEST_AREAS = [
  'Act I quests', 'Act II quests', 'save and load', 'controller support', 'Steam Deck', 'ultrawide displays',
  'German build', 'Japanese build', 'Simplified Chinese build', 'Italian build', 'achievements', 'cloud saves',
  'photo mode', 'audio settings', 'accessibility options', 'first-hour onboarding', 'boss encounters',
  'fast travel', 'crafting', 'low-spec PC',
];

/** One task's name and description, for a slot in a division (and maybe a team). */
function taskContent(division, team) {
  const chapter = int(1, 9);
  if (division === 'Writing') {
    const lang = team?.country?.lang;
    const area = pick(WRITING_AREAS);
    if (!lang || lang === 'English') {
      return {
        name: `${pick(SOURCE_WRITING)} ${area} — Chapter ${chapter}`,
        description: `Source text for the ${area} in Chapter ${chapter}. Keep the voice consistent with the style guide and flag any lore questions in the thread.`,
      };
    }
    return {
      name: `${pick(LOC_WRITING)} ${area} — Chapter ${chapter} (${lang})`,
      description: `${lang} pass over the ${area} in Chapter ${chapter}. Follow the ${lang} glossary; keep line lengths within the UI limits and note anything that needs context.`,
    };
  }
  if (division === 'Coding') {
    const local = team?.country && chance(0.35) ? pick(COUNTRY_CODE[team.country.name]) : null;
    const component = local ?? pick(CODE_COMPONENTS);
    const verb = pick(CODE_VERBS);
    return {
      name: `${verb} ${component}${local ? '' : ` (v${int(1, 3)}.${int(0, 9)})`}`,
      description: `${verb} the ${component}. Include repro steps or a short test plan in your submission, and link the merge request.`,
    };
  }
  if (division === 'Art') {
    if (team?.kind === '3d') {
      const place = pick(PLACES);
      return {
        name: `${pick(MODELING)} ${place} set`,
        description: `Game-ready assets for the ${place}. Stay within the prop budget; export FBX with the standard naming and include a turntable render.`,
      };
    }
    if (team?.kind === 'portrait') {
      const who = pick(CHARACTERS);
      return {
        name: `${pick(PORTRAIT)} ${who}`,
        description: `Character art for ${who}. Match the established palette; deliver a layered PSD and a 2K PNG.`,
      };
    }
    const place = pick(PLACES);
    return {
      name: `${pick(CONCEPT)} — ${place}`,
      description: `Early exploration for the ${place}: three directions, warm lamplight, late evening. PNG, 2K wide.`,
    };
  }
  const area = pick(TEST_AREAS);
  return {
    name: `${pick(TEST_KINDS)} — ${area}`,
    description: `Work through the ${area} checklist on the latest nightly. Log every issue with build number, steps and a capture; summarise blockers in the submission.`,
  };
}

const STATES = [
  ['open', 18], ['claimed', 20], ['review', 15], ['revising', 9], ['approved', 10], ['done', 22], ['retired', 6],
];

const DELIVERABLES = [
  'Done — files are in the shared drive under this task’s name.',
  'First full pass complete; two open questions noted at the top of the doc.',
  'Uploaded to the review folder. Happy to iterate on anything that feels off.',
  'All items covered. Left a couple of alternates for the trickier ones.',
  'Finished and self-checked against the style guide.',
];
const RETURN_NOTES = [
  'Close, but needs another pass on consistency.',
  'A few items drift from the glossary — see my notes.',
  'Good start. Please tighten the second half.',
  'Let’s revisit the scale; it reads a bit large next to the existing set.',
];
const APPROVE_NOTES = ['Looks good — approved.', 'Great work, thank you!', 'Approved. Merging this in.', 'Exactly what we needed.'];
const THREAD_OPENERS = [
  'Quick heads-up: the reference pack was updated this morning.',
  'Any blockers so far? Shout if you need context.',
  'Priority bumped — we’d like this for the next milestone.',
  'Linking the previous chapter’s version for reference.',
];
const THREAD_REPLIES = [
  'Thanks, on it.', 'Got it — should have something by Friday.', 'One question: do we keep the old naming?',
  'Seen, will pick this up after my current task.',
];

// ── Idempotent ensure-helpers ────────────────────────────────────────────────

let admin; // { cookie, csrf }
let existingGrants = new Set(); // `${roleId}|${action}|${scopeKind}`

async function ensureRole(name) {
  const roles = must(await req('GET', '/roles', { session: admin }), 'GET /roles');
  const found = roles.find((r) => r.name === name && r.lifecycleState === 'active');
  if (found) return found.id;
  return must(await req('POST', '/roles', { session: admin, body: { name } }), `create role ${name}`).id;
}

async function grant(roleId, action, scopeKind) {
  const sig = `${roleId}|${action}|${scopeKind}`;
  if (existingGrants.has(sig)) return;
  const r = await req('POST', '/grants', { session: admin, body: { roleId, action, scopeKind } });
  if (ok(r)) existingGrants.add(sig);
  else log(c.warn(`  grant ${action}/${scopeKind} → ${r.status} (skipped)`));
}

async function ensureDivision(name, existing) {
  const found = existing.find((d) => d.name === name && d.lifecycleState === 'active');
  if (found) return found;
  return must(await req('POST', '/divisions', { session: admin, body: { name } }), `create division ${name}`);
}

/** `body` is `{ divisionIds }` or `{ allDivisions: true }`. */
async function ensureTeam(name, body, existing) {
  const found = existing.find((t) => t.name === name && t.lifecycleState === 'active');
  if (found) return found;
  return must(await req('POST', '/teams', { session: admin, body: { name, ...body } }), `create team ${name}`);
}

async function setRequestTemplate(divisionId) {
  // A default template with one free-text question, so claimants have something to
  // submit against. Non-destructive: skipped when the division already has templates.
  const existing = must(
    await req('GET', `/divisions/${divisionId}/request-templates`, { session: admin }),
    'list division templates',
  );
  if ((existing?.length ?? 0) > 0) return;
  must(
    await req('POST', `/divisions/${divisionId}/request-templates`, {
      session: admin,
      body: {
        name: 'Deliverable',
        isDefault: true,
        questions: [{ type: 'text', prompt: 'Deliverable notes', required: false, constraints: {} }],
      },
    }),
    'create default template',
  );
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

/** Create a task as its requester and walk it to `spec.state` through the API. */
async function driveTask(spec) {
  const { requester, claimants, state } = spec;
  const task = soft(
    await req('POST', '/tasks', {
      session: requester.session,
      body: {
        name: spec.name,
        description: spec.description,
        divisionId: spec.divisionId,
        teamId: spec.teamId,
        template: { kind: 'default' },
      },
    }),
    `create "${spec.name}" as ${requester.name}`,
  );
  if (!task) return false;
  const path = `/tasks/${task.id}`;

  if (spec.openings > 1) {
    soft(await req('POST', `${path}/claims`, { session: requester.session, body: { openingsDelta: spec.openings - 1 } }), 'open seats');
  }
  for (const u of claimants) {
    soft(await req('POST', `${path}/claim`, { session: u.session }), `claim by ${u.name}`);
  }

  if (['review', 'revising', 'approved', 'done'].includes(state)) {
    const qn = soft(await req('GET', `${path}/request-template`, { session: requester.session }), 'get task template');
    const questionId = qn?.questions?.[0]?.id;
    for (const u of claimants) {
      soft(
        await req('POST', `${path}/submissions`, {
          session: u.session,
          body: { answers: questionId ? [{ questionId, value: pick(DELIVERABLES) }] : [] },
        }),
        `submit by ${u.name}`,
      );
    }
  }

  if (['revising', 'approved', 'done'].includes(state)) {
    const subs = soft(await req('GET', `${path}/submissions`, { session: requester.session }), 'list submissions') ?? [];
    for (const s of subs) {
      const decision = state === 'revising' ? 'return' : 'approve';
      soft(
        await req('POST', `/submissions/${s.id}/review`, {
          session: requester.session,
          body: { decision, comment: pick(decision === 'return' ? RETURN_NOTES : APPROVE_NOTES) },
        }),
        `${decision} submission`,
      );
      if (state === 'revising') break; // one return is enough to send the task back
    }
  }

  if (state === 'done') {
    soft(await req('POST', `${path}/complete`, { session: requester.session }), 'complete');
  }

  if (spec.thread && state !== 'open') {
    soft(await req('POST', `${path}/messages`, { session: requester.session, body: { body: pick(THREAD_OPENERS) } }), 'post message');
    if (claimants[0] && chance(0.6)) {
      soft(await req('POST', `${path}/messages`, { session: claimants[0].session, body: { body: pick(THREAD_REPLIES) } }), 'reply');
    }
  }

  if (state === 'retired') {
    soft(await req('POST', `${path}/retire`, { session: requester.session }), 'retire');
  }
  return true;
}

/** Spread `total` tasks over the units: [division, team | null, weight]. */
function planTasks(total, units) {
  const weightSum = units.reduce((s, u) => s + u.weight, 0);
  const counts = units.map((u) => Math.floor((total * u.weight) / weightSum));
  for (let i = 0; counts.reduce((a, b) => a + b, 0) < total; i++) counts[i % counts.length]++;

  const specs = [];
  const seen = new Set();
  units.forEach((unit, ui) => {
    for (let n = 0; n < counts[ui]; n++) {
      let content = taskContent(unit.division, unit.team);
      for (let tries = 0; seen.has(content.name) && tries < 20; tries++) content = taskContent(unit.division, unit.team);
      if (seen.has(content.name)) content = { ...content, name: `${content.name} — part ${n + 2}` };
      seen.add(content.name);

      const state = weighted(STATES);
      const requester = pick(unit.pool);
      const others = unit.pool.filter((u) => u !== requester);
      const working = state !== 'open' && !(state === 'retired' && chance(0.5));
      const seats = working ? Math.min(others.length, weighted([[1, 75], [2, 20], [3, 5]])) : 0;
      const claimants = sample(others, seats);
      const openings = Math.max(seats, state === 'open' && chance(0.25) ? 2 : 1);
      specs.push({
        ...content,
        divisionId: unit.divisionId,
        teamId: unit.teamId,
        unitLabel: unit.label,
        state,
        requester,
        claimants,
        openings,
        thread: chance(0.3),
      });
    }
  });
  // Interleave units so the task list (newest first) looks like a busy org, not blocks.
  for (let i = specs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [specs[i], specs[j]] = [specs[j], specs[i]];
  }
  return specs;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const run = async () => {
  const t0 = Date.now();
  log(c.dim(`Target: ${BASE}`));

  step('Authenticating');
  admin = await getAdminSession();

  step('Roles + permissions');
  const usersList = must(await req('GET', '/users', { session: admin }), 'GET /users');
  const adminRoleId = usersList.find((u) => u.email === ADMIN_EMAIL)?.roleIds?.[0];
  if (!adminRoleId) throw new Error('Could not resolve the admin role.');
  existingGrants = new Set(
    must(await req('GET', '/grants', { session: admin }), 'GET /grants').map(
      (g) => `${g.roleId}|${g.action}|${g.scopeKind}`,
    ),
  );
  // Fresh installs seed a Member role with these (ADR 0016); older ones may not have it.
  const memberRoleId = await ensureRole('Member');
  for (const [action, scope] of [
    ['task:read', 'own'], ['task:assign', 'own'], ['task:submit', 'own'], ['message:create', 'own'],
    ['task:create', 'own_division'], ['task:review', 'own'], ['task:complete', 'own'],
    ['task:retire', 'own'], ['task:manage_claims', 'own'],
  ]) {
    await grant(memberRoleId, action, scope);
  }
  const roles = must(await req('GET', '/roles', { session: admin }), 'GET /roles');
  const leadRole = roles.find((r) => r.name === 'Project lead' && r.lifecycleState === 'active');
  log(c.ok(`  Member role ready${leadRole ? ' · Project lead unit role found' : ''}`));

  step('Divisions + request templates');
  const existingDivs = must(await req('GET', '/divisions', { session: admin }), 'GET /divisions');
  const divisions = {};
  for (const name of DIVISIONS) {
    divisions[name] = await ensureDivision(name, existingDivs);
    await setRequestTemplate(divisions[name].id);
    log(c.ok(`  ${name}`));
  }

  step('Teams');
  const existingTeams = must(await req('GET', '/teams', { session: admin }), 'GET /teams');
  const teams = {};
  for (const t of TEAMS) {
    const body = t.all ? { allDivisions: true } : { divisionIds: t.divisions.map((dn) => divisions[dn].id) };
    teams[t.name] = { ...t, ...(await ensureTeam(t.name, body, existingTeams)) };
    log(c.ok(`  ${t.name} ${c.dim(`(${t.all ? 'all divisions' : t.divisions.join(', ')})`)}`));
  }

  step('Users');
  const people = buildPeople();
  const users = {};
  for (const p of people) {
    users[p.name] = { ...p, ...(await ensureUser({ email: p.email, displayName: p.name, roleIds: [memberRoleId] })) };
  }

  step('Memberships');
  const want = new Map(); // `${unitType}|${unitId}|${userId}` → change
  const addWant = (unitType, unitId, userId) =>
    want.set(`${unitType}|${unitId}|${userId}`, { op: 'add', unitType, unitId, userId });
  for (const p of people) {
    const u = users[p.name];
    for (const tn of p.teams) addWant('team', teams[tn].id, u.userId);
    for (const dn of divisionsOf(p)) addWant('division', divisions[dn].id, u.userId);
  }
  const current = must(await req('GET', '/memberships', { session: admin }), 'GET /memberships');
  for (const m of current.items) want.delete(`${m.unitType}|${m.unitId}|${m.userId}`);
  const changes = [...want.values()];
  if (changes.length) {
    must(await req('POST', '/memberships/batch', { session: admin, body: { changes } }), 'membership batch');
  }
  log(c.ok(`  ${changes.length} memberships added`) + c.dim(` (${current.items.length} already in place)`));

  step('Project leads');
  if (!leadRole) {
    log(c.warn('  no "Project lead" role on this instance — skipped'));
  } else {
    let added = 0;
    const assigned = new Map(); // unit path → Set(userId)
    for (const p of people) {
      for (const lead of p.leads) {
        const unitPath = lead.team ? `/teams/${teams[lead.team].id}` : `/divisions/${divisions[lead.division].id}`;
        if (!assigned.has(unitPath)) {
          const rows = must(await req('GET', `${unitPath}/role-assignments`, { session: admin }), 'list role assignments');
          assigned.set(unitPath, new Set(rows.filter((r) => r.roleId === leadRole.id).map((r) => r.userId)));
        }
        if (assigned.get(unitPath).has(users[p.name].userId)) continue;
        soft(
          await req('POST', `${unitPath}/role-assignments`, {
            session: admin,
            body: { userId: users[p.name].userId, roleId: leadRole.id },
          }),
          `lead ${p.name}`,
        );
        added++;
      }
    }
    log(c.ok(`  ${added} lead assignments added`));
  }

  step(`Tasks (${TASK_COUNT}, every status)`);
  const existingTasks = must(await req('GET', '/tasks?limit=1&include=retired', { session: admin }), 'GET /tasks');
  if (existingTasks.items.length > 0 && !APPEND) {
    log(c.dim('  this instance already has tasks — skipped (pass --append to add another set)'));
  } else {
    const membersOf = (pred) => people.filter(pred).map((p) => users[p.name]);
    const inDivision = (dn) => (p) => divisionsOf(p).has(dn);
    // A team's tasks, per division it serves: requested and worked by its members there.
    // Playtest (every division) files its own in Testing and Coding.
    const teamUnits = (t) =>
      (t.all ? ['Testing', 'Coding'] : t.divisions).map((dn) => ({
        label: `${t.name} (${dn})`,
        division: dn,
        divisionId: divisions[dn].id,
        team: t,
        teamId: teams[t.name].id,
        pool: membersOf((p) => p.teams.includes(t.name) && inDivision(dn)(p)),
        weight: t.all ? (dn === 'Testing' ? 4 : 1.5) : dn === 'Art' ? 9 : dn === 'Writing' ? 6 : 5.6,
      }));
    const units = [
      ...TEAMS.flatMap(teamUnits),
      ...DIVISIONS.map((dn) => ({
        label: dn,
        division: dn,
        divisionId: divisions[dn].id,
        team: null,
        teamId: undefined,
        pool: membersOf(inDivision(dn)),
        weight: dn === 'Testing' ? 18 : 2,
      })),
    ];
    const specs = planTasks(TASK_COUNT, units);
    const tally = {};
    let made = 0;
    for (const [i, spec] of specs.entries()) {
      if (await driveTask(spec)) {
        made++;
        tally[spec.state] = (tally[spec.state] ?? 0) + 1;
      }
      if ((i + 1) % 25 === 0 || i + 1 === specs.length) {
        log(`  ${c.ok('✓')} ${made}/${specs.length} ${c.dim(`(${Math.round((Date.now() - t0) / 1000)}s)`)}`);
      }
    }
    log(c.dim(`  by status: ${Object.entries(tally).map(([s, n]) => `${s} ${n}`).join(' · ')}`));
  }

  log(c.ok(`\n✓ Seed complete in ${Math.round((Date.now() - t0) / 1000)}s (${requestCount} requests${warnings ? `, ${warnings} warnings` : ''}).`));
  log(c.dim(`  Admin login (${ADMIN_NAME}): ${ADMIN_EMAIL} / ${PASSWORD}`));
  log(c.dim(`  ${people.length} members, same password — e.g. ${people.slice(0, 3).map((p) => p.email).join(', ')}`));
  log(c.dim('  Open the web app and visit /tasks.'));
};

run().catch((e) => {
  console.error(c.bad(`\nSeed failed: ${e.message}`));
  process.exitCode = 1;
});
