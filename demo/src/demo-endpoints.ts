import type { DemoMail } from './demo-mail';
/**
 * The demo's own endpoints, under `/__demo/`, answered by the service worker before
 * anything reaches the API. The demo header uses them; the API never sees them.
 *
 *   GET  /__demo/state    whether the demo is running, who you are, and who you can be.
 *                         `?peek` answers without starting the API (the start page).
 *   POST /__demo/switch   { key }: become that person.
 *   GET  /__demo/inbox    the current person's mail (list).
 *   GET  /__demo/inbox/:id  one message, marked read.
 *
 * Switching never bypasses the app. A member is signed in through the real
 * `POST /api/auth/login` with their demo password, so every rule the app has applies
 * (a retired user is refused with the app's own message). Anonymous and invitees are
 * the real `POST /api/auth/logout`. The demo only remembers which invitee you're being
 * (they have no account, so no session can say so) and the passwords people chose when
 * accepting an invitation during the demo.
 */

/** A demo user from personas.json (scripts/personas.mjs). */
export interface Persona {
  key: string;
  email: string;
  password: string;
  label: string;
  description: string;
}

export type PersonKind = 'persona' | 'joined' | 'invitee' | 'anonymous' | 'other';

/** One entry in the switcher. */
export interface Person {
  key: string;
  kind: PersonKind;
  label: string;
  email: string | null;
  description: string;
  current: boolean;
  /** Whether choosing it does anything (someone signed in by hand can't be chosen back). */
  switchable: boolean;
}

export interface DemoUser {
  id: string;
  email: string | null;
  displayName: string;
}

/** A mailbox: the addresses it receives for, and how much is unread. */
export interface InboxSummary {
  addresses: string[];
  unread: number;
}

export interface DemoState {
  started: true;
  running: boolean;
  build: string;
  user: DemoUser | null;
  current: Person | null;
  people: Person[];
  /** The current person's mailbox; null for Anonymous (no address). */
  inbox: InboxSummary | null;
}

/** Mail as the inbox lists it. */
export interface MailSummary {
  id: string;
  to: string;
  from: string;
  subject: string;
  date: string;
  read: boolean;
  preview: string;
}

/** What the demo itself remembers (per build, cleared with the demo's data). */
export interface DemoStore {
  /** The invitee you're being while signed out, by email. */
  actingAs: string | null;
  /** Passwords chosen when accepting an invitation during the demo, by email. */
  credentials: Record<string, string>;
}

/** The slice of the Prisma client the demo reads. */
export interface DemoDb {
  invitation: {
    findMany(args: unknown): Promise<{ email: string | null; maxUses: number; useCount: number }[]>;
  };
  appUser: {
    findMany(args: unknown): Promise<{ email: string | null; displayName: string; lifecycleState: string }[]>;
  };
  authToken: {
    findMany(args: unknown): Promise<{ newEmail: string | null }[]>;
  };
}

export interface DemoContext {
  build: string;
  personas: Persona[];
  /** Whether the API is up already (it starts on the first request otherwise). */
  running(): boolean;
  /** Send a request through the API, with the demo's cookie jar, as the page would. */
  api(method: string, path: string, body?: unknown): Promise<Response>;
  db(): Promise<DemoDb>;
  loadStore(): Promise<DemoStore>;
  saveStore(store: DemoStore): Promise<void>;
  loadMail(): Promise<DemoMail[]>;
  saveMail(mail: DemoMail[]): Promise<void>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

async function currentUser(ctx: DemoContext): Promise<DemoUser | null> {
  const me = await ctx.api('GET', '/api/me');
  if (!me.ok) return null;
  const u = (await me.json()) as DemoUser;
  return { id: u.id, email: u.email, displayName: u.displayName };
}

/**
 * Everyone the switcher offers: the personas, people who joined through an invitation
 * during the demo, pending invitees (an email, not used up, not revoked or expired, no
 * account yet), and Anonymous. Plus whoever is signed in, if they're none of those.
 */
async function listPeople(ctx: DemoContext, user: DemoUser | null, store: DemoStore): Promise<Person[]> {
  const db = await ctx.db();
  const people: Person[] = [];
  const taken = new Set<string>();
  const add = (p: Omit<Person, 'current'>) => {
    taken.add(lower(p.email));
    people.push({ ...p, current: false });
  };

  for (const p of ctx.personas) {
    add({ key: `persona:${p.key}`, kind: 'persona', label: p.label, email: p.email, description: p.description, switchable: true });
  }

  const joinedEmails = Object.keys(store.credentials).filter((e) => !taken.has(e));
  if (joinedEmails.length) {
    const users = await db.appUser.findMany({ where: { email: { in: joinedEmails } } });
    for (const u of users) {
      add({
        key: `joined:${lower(u.email)}`,
        kind: 'joined',
        label: u.displayName,
        email: u.email,
        description: 'Joined through an invitation during the demo',
        switchable: true,
      });
    }
  }

  const invites = await db.invitation.findMany({
    where: { email: { not: null }, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
  });
  const pending = invites.filter((i) => i.useCount < i.maxUses && i.email && !taken.has(lower(i.email)));
  if (pending.length) {
    // An invitation to someone who already has an account isn't an invitee.
    const existing = new Set(
      (await db.appUser.findMany({ where: { email: { in: pending.map((i) => i.email!) } } })).map((u) => lower(u.email)),
    );
    for (const i of pending) {
      if (existing.has(lower(i.email)) || taken.has(lower(i.email))) continue;
      add({ key: `invitee:${lower(i.email)}`, kind: 'invitee', label: i.email!, email: i.email, description: 'Invited; no account yet', switchable: true });
    }
  }

  add({ key: 'anonymous', kind: 'anonymous', label: 'Anonymous', email: null, description: 'No account: signed out', switchable: true });

  // Who you are now: the session decides; signed out, the invitee you chose, or Anonymous.
  let current: Person | undefined;
  if (user) {
    current = people.find((p) => (p.kind === 'persona' || p.kind === 'joined') && lower(p.email) === lower(user.email));
    if (!current) {
      current = { key: `user:${lower(user.email)}`, kind: 'other', label: user.displayName, email: user.email, description: 'Signed in through the app', current: false, switchable: false };
      people.splice(people.length - 1, 0, current);
    }
  } else if (store.actingAs) {
    current = people.find((p) => p.kind === 'invitee' && lower(p.email) === store.actingAs);
  }
  current ??= people.find((p) => p.kind === 'anonymous');
  current!.current = true;
  return people;
}

/**
 * The addresses the current person receives mail at, like a single-user mail client:
 * a signed-in user's email, plus the new address of an email change they haven't
 * confirmed yet (that confirmation goes to the new address); an invitee's invited
 * address; none for Anonymous.
 */
async function mailAddresses(ctx: DemoContext, user: DemoUser | null, current: Person | null): Promise<string[] | null> {
  if (user) {
    const pending = await (await ctx.db()).authToken.findMany({
      where: { userId: user.id, kind: 'email_change', consumedAt: null, expiresAt: { gt: new Date() } },
    });
    return [...new Set([user.email, ...pending.map((t) => t.newEmail)].filter((a): a is string => !!a).map(lower))];
  }
  if (current?.kind === 'invitee' && current.email) return [lower(current.email)];
  return null;
}

const inMailbox = (addresses: string[]) => (m: DemoMail) => addresses.includes(lower(m.to));

async function state(ctx: DemoContext): Promise<DemoState> {
  const store = await ctx.loadStore();
  const user = await currentUser(ctx);
  const people = await listPeople(ctx, user, store);
  const current = people.find((p) => p.current) ?? null;
  const addresses = await mailAddresses(ctx, user, current);
  const inbox = addresses && {
    addresses,
    unread: (await ctx.loadMail()).filter((m) => inMailbox(addresses)(m) && !m.read).length,
  };
  return { started: true, running: true, build: ctx.build, user, current, people, inbox };
}

async function inbox(ctx: DemoContext, id: string | null): Promise<Response> {
  const store = await ctx.loadStore();
  const user = await currentUser(ctx);
  const people = await listPeople(ctx, user, store);
  const addresses = await mailAddresses(ctx, user, people.find((p) => p.current) ?? null);
  if (!addresses) return json({ addresses: [], messages: [] });
  const all = await ctx.loadMail();
  const mine = all.filter(inMailbox(addresses));
  if (id === null) {
    const messages: MailSummary[] = mine
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((m) => ({
        id: m.id,
        to: m.to,
        from: m.from,
        subject: m.subject,
        date: m.date,
        read: m.read,
        preview: m.text.replace(/\s+/g, ' ').slice(0, 140),
      }));
    return json({ addresses, messages });
  }
  const message = mine.find((m) => m.id === id);
  if (!message) return json({ error: { code: 'NOT_FOUND', message: 'No such message in this mailbox' } }, 404);
  if (!message.read) {
    message.read = true;
    await ctx.saveMail(all);
  }
  return json(message);
}

/** The app's error message, as the API sent it. */
async function appError(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return { code: body?.error?.code ?? `HTTP_${res.status}`, message: body?.error?.message ?? `The app answered ${res.status}` };
}

async function switchTo(ctx: DemoContext, key: string): Promise<Response> {
  const store = await ctx.loadStore();
  const user = await currentUser(ctx);
  const people = await listPeople(ctx, user, store);
  const target = people.find((p) => p.key === key);
  if (!target || !target.switchable) return json({ error: { code: 'NOT_FOUND', message: `No one to switch to as "${key}"` } }, 404);

  if (target.kind === 'persona' || target.kind === 'joined') {
    const password =
      target.kind === 'persona'
        ? ctx.personas.find((p) => `persona:${p.key}` === key)!.password
        : store.credentials[lower(target.email)];
    // The real login: the app decides. If it refuses, you stay who you were.
    const res = await ctx.api('POST', '/api/auth/login', { email: target.email, password });
    if (!res.ok) return json({ error: await appError(res) }, res.status);
    await ctx.saveStore({ ...store, actingAs: null });
    return json({ ok: true, current: key });
  }

  // Anonymous, or an invitee (no account yet): signed out, as the app does it.
  if (user) {
    const res = await ctx.api('POST', '/api/auth/logout');
    if (!res.ok) return json({ error: await appError(res) }, res.status);
  }
  await ctx.saveStore({ ...store, actingAs: target.kind === 'invitee' ? lower(target.email) : null });
  return json({ ok: true, current: key });
}

export async function handleDemoRequest(request: Request, ctx: DemoContext): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;

  if (route === 'GET /__demo/state') {
    if (url.searchParams.has('peek') && !ctx.running()) {
      return json({ started: true, running: false, build: ctx.build, user: null, current: null, people: [], inbox: null } satisfies DemoState);
    }
    return json(await state(ctx));
  }

  if (route === 'POST /__demo/switch') {
    const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
    if (typeof body?.key !== 'string') return json({ error: { code: 'BAD_REQUEST', message: 'Send { "key": "..." }' } }, 400);
    return switchTo(ctx, body.key);
  }

  if (route === 'GET /__demo/inbox') return inbox(ctx, null);
  const message = /^GET \/__demo\/inbox\/([^/]+)$/.exec(route);
  if (message) return inbox(ctx, decodeURIComponent(message[1]));

  return json({ error: { code: 'NOT_FOUND', message: `No demo endpoint ${route}` } }, 404);
}

/** `POST /api/invite/:token/accept`: the request whose password the demo remembers. */
export const ACCEPT_INVITE = /^\/api\/invite\/[^/]+\/accept$/;
