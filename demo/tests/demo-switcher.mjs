// The user switcher: become a demo user, Anonymous, a new invitee, then that invitee
// once they've accepted; a deactivated user is refused with the app's own message and
// you stay who you were; it works from the keyboard.
//   BASE_URL=http://localhost:4400 node tests/demo-switcher.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4400';
const OUT = process.argv[2] ?? '.build/screenshots/demo-switcher';
mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'patrice-switch-')), {
  viewport: { width: 1200, height: 820 },
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
const inHeader = (fn, arg) =>
  page.evaluate(
    ([src, a]) => new Function('root', 'arg', src)(document.querySelector('patrice-demo-header')?.shadowRoot, a),
    [fn, arg],
  );
const buttonText = () => inHeader("return root?.querySelector('.who .label')?.textContent?.trim()");
const waitButton = (text) =>
  page.waitForFunction(
    (t) => document.querySelector('patrice-demo-header')?.shadowRoot?.querySelector('.who .label')?.textContent?.includes(t),
    text,
    { timeout: 20_000 },
  );
const openMenu = async () => {
  await inHeader("if (root.querySelector('.menu').hidden) root.querySelector('.who').click()");
  await page.waitForFunction(
    () => {
      const r = document.querySelector('patrice-demo-header')?.shadowRoot;
      const m = r?.querySelector('.menu');
      return m && !m.hidden && !m.hasAttribute('aria-busy') && r.querySelectorAll('.item').length > 0;
    },
    null,
    { timeout: 20_000 },
  );
};
const menu = () =>
  inHeader(`return [...root.querySelectorAll('.group, .item')].map((el) => el.classList.contains('group')
    ? '# ' + el.textContent.trim()
    : (el.getAttribute('aria-checked') === 'true' ? '* ' : '  ') + el.querySelector('.name').textContent.trim())`);
const choose = async (label) => {
  await openMenu();
  await inHeader(
    "[...root.querySelectorAll('.item')].find((i) => i.querySelector('.name').textContent.trim() === arg).click()",
    label,
  );
};
const csrf = () => page.evaluate(() => decodeURIComponent(document.cookie.match(/patrice_csrf=([^;]+)/)?.[1] ?? ''));
const api = async (method, path, body) =>
  page.evaluate(
    async ([m, p, b, token]) => {
      const r = await fetch('/api' + p, {
        method: m,
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, path, body, await csrf()],
  );

// Start the demo; a fresh visitor is Anonymous.
await page.goto(`${BASE}/demo`);
await page.click('#start:not([disabled])');
await page.waitForSelector('input[type=email]', { timeout: 60_000 });
await waitButton('Anonymous');
check((await buttonText()).startsWith('Anonymous'), `fresh visitor: "${await buttonText()}"`);
await openMenu();
let m = await menu();
console.log('     menu:', m.join(' | '));
check(m.includes('# Demo users') && m.includes('* Anonymous'), 'menu lists the demo users, with Anonymous current');
await shot('1-menu-anonymous');

// Become the admin: through the real login, then into the app.
await choose('Admin');
await page.waitForURL('**/home', { timeout: 20_000 });
await waitButton('Admin');
check((await buttonText()).includes('Admin'), `after choosing Admin: "${await buttonText()}"`);
check(
  await page.waitForSelector('text=admin@example.com', { timeout: 15_000 }).then(() => true, () => false),
  'the app shows the admin',
);
await shot('2-admin');

// As admin, invite someone new: they appear under "Invited".
const email = `newbie-${Date.now()}@example.com`;
const invite = await api('POST', '/invitations', { email });
check(invite.status === 201, `admin invites ${email} (${invite.status})`);
const st = await page.evaluate(async () => (await (await fetch('/__demo/state')).json()).people.map((p) => `${p.kind}:${p.label}`));
console.log('     state:', st.join(' | '));
await openMenu();
m = await menu();
check(m.includes('# Invited (no account yet)') && m.some((x) => x.trim() === email), 'the invitee is in the menu');
await shot('3-menu-with-invitee');

// Become the invitee: signed out, header says so.
await inHeader(
  "[...root.querySelectorAll('.item')].find((i) => i.querySelector('.name').textContent.trim() === arg).click()",
  email,
);
await page.waitForURL((u) => !u.pathname.startsWith('/home') || true, { timeout: 5_000 });
await waitButton('Invitee');
check((await buttonText()).includes(email), `as the invitee: "${await buttonText()}"`);
await page.waitForSelector('input[type=email]', { timeout: 20_000 });
check(true, 'the invitee lands on the login page (no account)');

// The invitee accepts (as they would from the link they were given).
const accepted = await page.evaluate(
  async ([token, e]) => {
    const r = await fetch(`/api/invite/${token}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'a fresh demo password', displayName: 'Newbie Nguyen' }),
    });
    return r.status;
  },
  [invite.body.token, email],
);
check(accepted >= 200 && accepted < 300, `the invitee accepts the invitation (${accepted})`);
await page.waitForTimeout(800);
await openMenu();
m = await menu();
console.log('     menu:', m.join(' | '));
check(m.includes('# Joined during the demo') && m.some((x) => x.includes('Newbie Nguyen')), 'they now appear under "Joined during the demo"');
check(!m.some((x) => x.trim() === email), 'and no longer as an invitee');
await inHeader("root.querySelector('.who').click()"); // close

// Switch to Admin, then back to the new member through the real login.
await choose('Admin');
await page.waitForURL('**/home');
await waitButton('Admin');
await choose('Newbie Nguyen');
await page.waitForURL('**/home');
await waitButton('Newbie');
check((await buttonText()).includes('Newbie Nguyen'), `signed in as the new member: "${await buttonText()}"`);
await shot('4-new-member');

// The app's rules apply: deactivate them (as admin), then try to switch to them.
await choose('Admin');
await page.waitForURL('**/home');
await waitButton('Admin');
const users = await api('GET', '/users');
const newbie = (users.body.items ?? users.body).find((u) => u.email === email);
const deactivated = await api('POST', `/users/${newbie.id}/deactivate`, {});
check(deactivated.status < 300, `admin deactivates the new member (${deactivated.status})`);
await choose('Newbie Nguyen');
await page.waitForFunction(
  () => !document.querySelector('patrice-demo-header').shadowRoot.querySelector('.error').hidden,
  null,
  { timeout: 15_000 },
);
const err = await inHeader("return root.querySelector('.error').textContent");
console.log('     refusal:', err);
check(/Couldn't switch/.test(err), 'the switch is refused with the app\'s message');
check((await buttonText()).includes('Admin'), `and you stay who you were: "${await buttonText()}"`);
await shot('5-refused');
await page.keyboard.press('Escape');

// Keyboard: ArrowDown opens and focuses the first person; Escape closes.
await page.goto(`${BASE}/home`);
await waitButton('Admin');
await inHeader("root.querySelector('.who').focus()");
await page.keyboard.press('ArrowDown');
await page.waitForFunction(() => document.querySelector('patrice-demo-header').shadowRoot.activeElement?.classList.contains('item'), null, { timeout: 15_000 });
const focused = await inHeader("return root.activeElement?.querySelector('.name')?.textContent");
check(!!focused, `ArrowDown opens the menu and focuses "${focused}"`);
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Escape');
check(await inHeader("return root.querySelector('.menu').hidden && root.activeElement?.classList.contains('who')"), 'Escape closes it and returns focus to the button');

// Anonymous signs out.
await choose('Anonymous');
await page.waitForSelector('input[type=email]', { timeout: 20_000 });
await waitButton('Anonymous');
check(true, 'choosing Anonymous signs out to the login page');

await ctx.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall switcher checks passed');
process.exit(failures ? 1 : 0);
