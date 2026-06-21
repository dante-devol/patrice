// Selective visual-verification utility (ui-tailwind). NOT a CI test — a one-shot
// script that drives a running `ng serve` with Playwright, mocks every `/api/*` call
// with representative data, and saves a couple of full-page screenshots of the two
// Tasks pages so the drafting-board design can be eyeballed without standing up the
// API / Postgres / auth stack.
//
//   1) terminal A:  cd web && npm start
//   2) terminal B:  cd web && node tools/screenshot-tasks.mjs
//   → writes web/tools/screenshots/{tasks-overview,tasks-overview-create,task-detail}.png

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4200';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(OUT, { recursive: true });

const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

const me = {
  id: 'u-devin', organizationId: 'org', email: 'devin@example.com', displayName: 'Devin',
  emailVerified: true, capabilities: { inviteCreate: true, manageOrg: true },
};

const divisions = [
  { name: 'Writing', id: 'd-writing' }, { name: 'Art', id: 'd-art' },
  { name: 'Scripting', id: 'd-scripting' }, { name: 'Testing', id: 'd-testing' },
  { name: 'Leadership', id: 'd-leadership' },
].map((d) => ({
  ...d, defaultOpenings: 1, openingsLocked: false, restrictClaims: false,
  lifecycleState: 'active', retiredAt: null, version: 1, inherentRoleId: 'r-' + d.id,
}));

const teams = [
  { name: 'USA', id: 't-usa' }, { name: 'Artists', id: 't-artists' },
].map((t) => ({
  ...t, restrictClaims: false, lifecycleState: 'active', retiredAt: null, version: 1, inherentRoleId: 'r-' + t.id,
}));

const users = [
  ['u-devin', 'Devin'], ['u-maya', 'Maya'], ['u-aric', 'Aric'], ['u-sela', 'Sela'], ['u-joon', 'Joon'],
].map(([id, displayName]) => ({ id, email: null, displayName, lifecycleState: 'active', roleIds: [] }));

const task = (o) => ({
  claimsClosed: false, lifecycleState: 'active', retiredAt: null, version: 1,
  updatedAt: o.createdAt, teamId: null, description: '', ...o,
});

const tasks = [
  task({ id: 't-tavern', name: 'Tavern interior — concept sheet', divisionId: 'd-art', requesterUserId: 'u-sela', openings: 1, statusCache: 'open', createdAt: ago(6 * H), description: 'Three mood frames for the riverside tavern — warm lamplight, late evening. PNG, 2K wide.' }),
  task({ id: 't-localize', name: 'Localize Chapter 3 — tavern dialogue', divisionId: 'd-writing', teamId: 't-usa', requesterUserId: 'u-devin', openings: 2, statusCache: 'review', createdAt: ago(5 * D), description: 'Pass over the 40 tavern barks; keep cadence loose and in-character. Two translators on it.' }),
  task({ id: 't-save', name: 'Port save-system to the v2 schema', divisionId: 'd-scripting', requesterUserId: 'u-joon', openings: 1, statusCache: 'revising', createdAt: ago(8 * D), description: 'Migrate legacy save blobs; returned once — needs the backwards-compat shim Joon flagged.' }),
  task({ id: 't-regress', name: 'Regression pass — Act I quest flags', divisionId: 'd-testing', teamId: 't-usa', requesterUserId: 'u-aric', openings: 1, statusCache: 'claimed', createdAt: ago(2 * D), description: 'Walk every Act I branch; confirm flags clear on completion. Custom test form attached.' }),
  task({ id: 't-signoff', name: 'Sign off Act I voice direction', divisionId: 'd-leadership', requesterUserId: 'u-devin', openings: 1, statusCache: 'approved', createdAt: ago(11 * D), description: 'Final review of the Act I VO brief before recording opens. Approved by leadership.' }),
  task({ id: 't-barks', name: 'Write merchant barks — 20 lines', divisionId: 'd-writing', requesterUserId: 'u-maya', openings: 2, statusCache: 'open', createdAt: ago(1 * D), description: 'Short, repeatable merchant lines for the market district. Two writers welcome.' }),
];

const questionnaire = {
  id: 'q1', ownerDivisionId: 'd-writing', ownerTaskId: 't-localize',
  questions: [
    { id: 'q-lines', ordinal: 0, type: 'detail_text', prompt: 'Translated lines', required: true, constraints: {} },
    { id: 'q-notes', ordinal: 1, type: 'text', prompt: 'Translator notes', required: false, constraints: {} },
  ],
};

const submission = (o) => ({
  taskId: 't-localize', prevSubmissionId: null, reviewedBy: null, reviewedAt: null,
  lifecycleState: 'active', version: 1, answers: [], ...o,
});
const submissions = [
  submission({ id: 's-maya1', claimantUserId: 'u-maya', submissionNo: 1, state: 'revising', submittedAt: ago(3 * D), answers: [{ id: 'a0', questionId: 'q-lines', value: 'First pass at the tavern barks.', attachmentIds: [] }] }),
  submission({ id: 's-maya', claimantUserId: 'u-maya', submissionNo: 2, state: 'review', submittedAt: ago(2 * D), answers: [{ id: 'a1', questionId: 'q-lines', value: 'Reworked lines 4–9; loosened the goodbye line so the bartender reads bored, not formal.', attachmentIds: [] }] }),
  submission({ id: 's-aric', claimantUserId: 'u-aric', submissionNo: 1, state: 'review', submittedAt: ago(1 * D), answers: [{ id: 'a2', questionId: 'q-lines', value: 'First pass of the bartender set.', attachmentIds: [] }] }),
];

const msg = (o) => ({
  taskId: 't-localize', parentMessageId: null, lifecycleState: 'active', retiredAt: null,
  editedAt: null, version: 1, attachments: [], replies: [], kind: 'comment', ...o,
});
const messages = [
  msg({ id: 'm1', kind: 'system', senderUserId: null, body: 'User u-maya claimed this task.', createdAt: ago(4 * D) }),
  msg({ id: 'm2', kind: 'system', senderUserId: null, body: 'User u-aric claimed this task.', createdAt: ago(4 * D) }),
  // A submission event with its review decision + discussion threaded beneath it.
  msg({ id: 'm3', kind: 'system', senderUserId: null, body: 'User u-maya submitted version 1.', createdAt: ago(3 * D), replies: [
    msg({ id: 'm3r1', kind: 'comment', senderUserId: 'u-devin', body: 'The barks read a little stiff — can we loosen the cadence? Especially lines 4–9, the bartender should sound bored, not formal.', createdAt: ago(3 * D) }),
    msg({ id: 'm3r2', kind: 'system', senderUserId: null, body: 'Reviewer u-devin returned version 1.', createdAt: ago(3 * D) }),
    msg({ id: 'm3r3', kind: 'comment', senderUserId: 'u-maya', body: 'Good call. Reworked 4–9 and loosened the goodbye line — it was way too courtly.', createdAt: ago(2 * D) }),
  ] }),
  msg({ id: 'm7', kind: 'system', senderUserId: null, body: 'User u-maya submitted version 2.', createdAt: ago(2 * D) }),
  msg({ id: 'm8', kind: 'system', senderUserId: null, body: 'User u-aric submitted version 1.', createdAt: ago(1 * D) }),
  // A general comment thread (one-level replies are supported in the data model).
  msg({ id: 'c1', kind: 'comment', senderUserId: 'u-aric', body: 'Sharing my pass for a second set of eyes.', createdAt: ago(1 * D), replies: [
    msg({ id: 'c1r', kind: 'comment', senderUserId: 'u-devin', body: 'Looks solid — one nit on line 22, otherwise ship it.', createdAt: ago(1 * D) }),
  ] }),
];

const roles = [
  { id: 'r-admin', name: 'Org Admin', kind: 'standalone', divisionId: null, teamId: null, lifecycleState: 'active', retiredAt: null, version: 1 },
  { id: 'r-lead', name: 'Division Lead', kind: 'division', divisionId: 'd-writing', teamId: null, lifecycleState: 'active', retiredAt: null, version: 1 },
];

function json(route, body) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mock(page) {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api/, '');
    if (p === '/me') return json(route, me);
    if (p === '/bootstrap') return json(route, { open: false, inviteToken: null });
    if (p === '/divisions') return json(route, divisions);
    if (p === '/teams') return json(route, teams);
    if (p === '/users') return json(route, users);
    if (p === '/notifications') return json(route, { items: [], unreadCount: 0, nextCursor: null });
    if (p.endsWith('/notifications/stream')) return route.abort();
    if (p === '/roles') return json(route, roles);
    if (p === '/grants') return json(route, []);
    if (p === '/actions') return json(route, { actions: ['task:create', 'task:claim', 'task:review'] });
    if (p === '/config') return json(route, { requireVerifiedEmailToLogIn: false, selfReviewAllowed: false, anonymizeLabel: false, sessionAbsoluteDays: 30, sessionIdleDays: 7, gracePeriodHours: 48 });
    if (p === '/tasks') return json(route, { items: tasks, nextCursor: null });
    if (p.endsWith('/questionnaire')) return json(route, questionnaire);
    if (p.endsWith('/submissions')) return json(route, submissions);
    if (p.endsWith('/messages')) return json(route, { items: messages, nextCursor: null });
    const t = p.match(/^\/tasks\/([^/]+)$/);
    if (t) return json(route, tasks.find((x) => x.id === t[1]) ?? tasks[1]);
    return json(route, {});
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await mock(page);

await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await page.getByText('Localize Chapter 3 — tavern dialogue').waitFor();
await page.screenshot({ path: join(OUT, 'tasks-overview.png'), fullPage: true });

await page.getByRole('button', { name: 'Request a task' }).click();
await page.getByText('What needs doing?').waitFor().catch(() => {});
await page.screenshot({ path: join(OUT, 'tasks-overview-create.png'), fullPage: true });

await page.goto(`${BASE}/tasks/t-localize`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Localize Chapter 3 — tavern dialogue' }).waitFor();
await page.screenshot({ path: join(OUT, 'task-detail.png'), fullPage: true });

// Review dialog — the 2nd "view submission" is Maya's v2 (in review → shows controls).
await page.getByRole('button', { name: /view submission/ }).nth(1).click();
await page.getByRole('button', { name: 'Approve' }).waitFor();
await page.screenshot({ path: join(OUT, 'review-dialog.png'), fullPage: true });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// Submit-work dialog from the claim strip.
await page.getByRole('button', { name: 'Submit work' }).click();
await page.getByRole('button', { name: 'Submit for review' }).waitFor();
await page.screenshot({ path: join(OUT, 'submit-dialog.png'), fullPage: true });
await page.keyboard.press('Escape');

await page.goto(`${BASE}/home`, { waitUntil: 'networkidle' });
await page.getByText(/Logged in as/).waitFor().catch(() => {});
await page.screenshot({ path: join(OUT, 'home.png'), fullPage: true });

await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'divisions' }).click().catch(() => {});
await page.getByText('Tavern', { exact: false }).waitFor().catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'admin-divisions.png'), fullPage: true });

// Login renders only when unauthenticated → drop the /me mock for this one.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const lp = await ctx.newPage();
await lp.route('**/api/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
  if (p === '/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  if (p === '/bootstrap') return json(route, { open: false, inviteToken: null });
  if (p.endsWith('/stream')) return route.abort();
  return json(route, {});
});
await lp.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await lp.getByRole('heading', { name: 'Log in' }).waitFor();
await lp.screenshot({ path: join(OUT, 'login.png'), fullPage: true });

await browser.close();
console.log('Screenshots written to', OUT);
