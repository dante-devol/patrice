// The demo inbox: Patrice's real mail (built by the real mail worker), filed for whoever
// it's addressed to and shown to whoever you are now.
//   BASE_URL=http://localhost:4400 node tests/demo-inbox.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4400';
const OUT = process.argv[2] ?? '.build/screenshots/demo-inbox';
mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-inbox-')), {
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 1.25,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('pageerror', e.message));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const inHeader = (src, arg) =>
  page.evaluate(([s, a]) => new Function('root', 'arg', s)(document.querySelector('patrice-demo-header')?.shadowRoot, a), [src, arg]);
const waitHeader = (src, arg, timeout = 20_000) =>
  page.waitForFunction(([s, a]) => new Function('root', 'arg', s)(document.querySelector('patrice-demo-header')?.shadowRoot, a), [src, arg], {
    timeout,
  });
const badge = () => inHeader("const b = root.querySelector('.badge'); return b.hidden ? 0 : Number(b.textContent)");
const openInbox = async () => {
  await inHeader("if (root.querySelector('.panel').hidden) root.querySelector('.mail-btn').click()");
  await waitHeader("const p = root.querySelector('.panel'); return !p.hidden && !p.hasAttribute('aria-busy')");
};
const closeInbox = () => inHeader("if (!root.querySelector('.panel').hidden) root.querySelector('.mail-btn').click()");
const inboxText = () => inHeader("return root.querySelector('.panel').innerText");
const subjects = () => inHeader("return [...root.querySelectorAll('.msg .subj')].map((e) => e.textContent.trim())");
const switchTo = async (label) => {
  await closeInbox();
  await inHeader("if (root.querySelector('.menu').hidden) root.querySelector('.who').click()");
  await waitHeader("const m = root.querySelector('.menu'); return !m.hidden && !m.hasAttribute('aria-busy') && root.querySelectorAll('.item').length");
  await inHeader("[...root.querySelectorAll('.item')].find((i) => i.querySelector('.name').textContent.trim() === arg).click()", label);
  await page.waitForLoadState('load');
  await waitHeader("return root.querySelector('.who .label').textContent.includes(arg)", label === 'Anonymous' ? 'Anonymous' : label);
};
const post = (path, body) =>
  page.evaluate(
    async ([p, b]) => {
      const csrf = decodeURIComponent(document.cookie.match(/patrice_csrf=([^;]+)/)?.[1] ?? '');
      const r = await fetch('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b) });
      return r.status;
    },
    [path, body],
  );

// Start; Anonymous has no mailbox.
await page.goto(`${BASE}/demo`);
await page.click('#start:not([disabled])');
await page.waitForSelector('input[type=email]', { timeout: 60_000 });
await waitHeader("return root.querySelector('.who .label').textContent.includes('Anonymous')");
await openInbox();
check((await inboxText()).includes('Anonymous has no mailbox'), 'Anonymous: no mailbox');
await shot('1-anonymous-no-mailbox');

// As Anonymous, ask for a password reset for the admin (the app's forgot-password).
const reset = await post('/auth/password-reset', { email: 'admin@example.com' });
check(reset < 300, `password reset requested for the admin (${reset})`);

// Switch to the admin: the reset mail is in their inbox, unread.
await switchTo('Admin');
await waitHeader("return !root.querySelector('.badge').hidden").catch(() => {});
check((await badge()) >= 1, `the admin's inbox badge shows unread mail (${await badge()})`);
await openInbox();
let subs = await subjects();
console.log('     admin inbox:', subs.join(' | '));
check(subs.includes('Reset your Patrice password'), 'the real reset mail is there');
await shot('2-admin-inbox');

// Open it: rendered in the sandboxed frame; the badge clears.
await inHeader("[...root.querySelectorAll('.msg')].find((m) => m.querySelector('.subj').textContent.includes('Reset')).click()");
await waitHeader("return !!root.querySelector('.body iframe')");
const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() === 'about:srcdoc');
const link = await frame?.evaluate(() => document.querySelector('a')?.getAttribute('href'));
console.log('     link:', link);
check(!!link && new URL(link).pathname === '/reset-password' && new URL(link).searchParams.get('token'), 'it links to /reset-password with a token');
await waitHeader("return root.querySelector('.badge').hidden").catch(() => {});
check((await badge()) === 0, 'reading it clears the badge');
await shot('3-reading-reset-mail');

// Clicking the link opens the real reset page in the demo.
await frame.click('a');
await page.waitForURL('**/reset-password?token=*', { timeout: 15_000 });
check(true, `the link opens ${new URL(page.url()).pathname} in the demo`);
await page.waitForSelector('input[type=password]', { timeout: 15_000 }).then(
  () => check(true, 'the reset page shows its form'),
  () => check(false, 'the reset page shows its form'),
);

// An email change: the confirmation goes to the new address, which this inbox includes
// while the change is pending.
await page.goto(`${BASE}/home`);
await waitHeader("return root.querySelector('.who .label').textContent.includes('Admin')");
const newEmail = `admin-${Date.now()}@example.org`;
const change = await post('/me/email', { newEmail, currentPassword: 'correct horse battery' });
check(change < 300, `the admin asks to change their email to ${newEmail} (${change})`);
await openInbox();
const head = await inHeader("return root.querySelector('.mhead').textContent");
subs = await subjects();
console.log('     ' + head.trim(), '·', subs.join(' | '));
check(head.includes(newEmail), 'the inbox also receives for the pending new address');
check(subs.includes('Confirm your new Patrice email address'), 'the confirmation mail is there');
await shot('4-email-change');

// An invitee has a mailbox for their invited address (empty: Patrice doesn't email invites).
const inviteEmail = `invitee-${Date.now()}@example.com`;
check((await post('/invitations', { email: inviteEmail })) === 201, 'the admin invites someone');
await switchTo(inviteEmail);
await openInbox();
const t = await inboxText();
check(t.includes(inviteEmail) && t.includes('No mail yet'), "the invitee's (empty) mailbox for their address");

await ctx.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall inbox checks passed');
process.exit(failures ? 1 : 0);
