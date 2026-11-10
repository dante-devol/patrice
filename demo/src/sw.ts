/// <reference lib="webworker" />
// The browser demo's "server": a service worker that answers /api/* by running the
// real Nest app against PGlite (Postgres in WebAssembly), persisted in IndexedDB.
import './sw-env';
import { PGlite } from '@electric-sql/pglite';
import { createDemoApp } from './demo-app';
import { CookieJar, SetCookie, createDispatcher } from './dispatch';
import { ACCEPT_INVITE, DemoDb, DemoStore, Persona, handleDemoRequest } from './demo-endpoints';
import { PrismaService } from '../../api/src/prisma/prisma.service';
// The bundler swaps this for shims/cedar.mjs (Cedar's web build).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { demoInitCedar } = require('@cedar-policy/cedar-wasm/nodejs') as { demoInitCedar: () => Promise<void> };

declare const self: ServiceWorkerGlobalScope;

// Set by the bundler: a hash of this build's database snapshot. Each build gets its
// own database, so a returning visitor never runs a new API against an old schema,
// and an old worker still alive during an update never writes the new one.
declare const __DEMO_BUILD__: string;
// Set by the bundler: the switcher's users (scripts/personas.mjs).
declare const __DEMO_PERSONAS__: Persona[];
const DB_NAME = `patrice-demo-${__DEMO_BUILD__}`;
const DB = `idb://${DB_NAME}`;
const JAR_KEY = `/__demo/cookie-jar-${__DEMO_BUILD__}`;
// The demo's own bookkeeping for the switcher (see DemoStore).
const STORE_KEY = `/__demo/store-${__DEMO_BUILD__}`;

// citext's extension bundle, served next to this worker.
const citext = {
  name: 'citext',
  setup: async () => ({ bundlePath: new URL('./citext.tar.gz', self.location.href) }),
};

type Server = { dispatch: ReturnType<typeof createDispatcher>; jar: CookieJar; db: DemoDb; close: () => Promise<void> };
let server: Promise<Server> | null = null;

/**
 * Report a boot stage to the console and to open pages (the boot bar shows it), so a
 * stalled start says where it stopped.
 */
function progress(t0: number, id: string, stage: string): void {
  const ms = Date.now() - t0;
  console.log(`[demo] ${stage} (${ms} ms)`);
  void self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((cs) => cs.forEach((c) => c.postMessage({ type: 'demo-progress', id, stage, ms })));
}

async function boot(): Promise<Server> {
  const t0 = Date.now();
  progress(t0, 'check', 'checking saved database');
  const databases = await indexedDB.databases();
  const existing = databases.some((d) => d.name === `/pglite/${DB_NAME}`);
  // Databases from earlier builds are stale: drop them (and their sessions).
  for (const d of databases) {
    if (d.name?.startsWith('/pglite/patrice-demo') && d.name !== `/pglite/${DB_NAME}`) indexedDB.deleteDatabase(d.name);
  }
  const cache = await caches.open('patrice-demo');
  for (const req of await cache.keys()) {
    if (!req.url.endsWith(JAR_KEY) && !req.url.endsWith(STORE_KEY)) await cache.delete(req);
  }
  // First visit: start from the seeded snapshot built with the real API.
  if (!existing) progress(t0, 'download', 'downloading demo data');
  const loadDataDir = existing ? undefined : await (await fetch(new URL('./demo-db.tar.gz', self.location.href))).blob();
  progress(t0, existing ? 'open' : 'database', existing ? 'opening database' : 'loading demo data into the database');
  // Durable writes: each query's changes reach IndexedDB before it answers, so a
  // worker stopped by the browser never leaves a half-written database behind.
  const db = await PGlite.create(DB, { extensions: { citext }, loadDataDir });
  progress(t0, 'policy', 'loading the policy engine');
  await demoInitCedar();
  progress(t0, 'api', 'starting the API');
  const app = await createDemoApp(db);
  await app.init();
  const saved = await cache.match(JAR_KEY);
  const jar: CookieJar = new Map(saved ? ((await saved.json()) as [string, string][]) : []);
  progress(t0, 'ready', `API ready (${existing ? 'existing' : 'fresh'} database)`);
  const close = async () => {
    await app.close();
    await db.close();
  };
  return { dispatch: createDispatcher(app), jar, db: app.get(PrismaService) as unknown as DemoDb, close };
}

function getServer(): Promise<Server> {
  // A failed boot is retried on the next request rather than cached forever.
  server ??= boot().catch((e) => {
    server = null;
    throw e;
  });
  return server;
}

async function loadStore(): Promise<DemoStore> {
  const saved = await (await caches.open('patrice-demo')).match(STORE_KEY);
  const store = saved ? ((await saved.json()) as Partial<DemoStore>) : {};
  return { actingAs: store.actingAs ?? null, credentials: store.credentials ?? {} };
}

async function saveStore(store: DemoStore): Promise<void> {
  await (await caches.open('patrice-demo')).put(STORE_KEY, new Response(JSON.stringify(store)));
}

/** Run a request through the API with the demo's cookie jar, and keep what it sets. */
async function viaApi(request: Request): Promise<Response> {
  const { dispatch, jar } = await getServer();
  // Someone accepting an invitation chooses a password: remember it, so the switcher can
  // sign in as them later (through the real login, like everyone else).
  const accepting =
    request.method === 'POST' && ACCEPT_INVITE.test(new URL(request.url).pathname)
      ? ((await request.clone().json().catch(() => null)) as { email?: string; password?: string } | null)
      : null;
  const { response, cookies } = await dispatch(request, jar);
  if (accepting?.email && accepting.password && response.ok) {
    const store = await loadStore();
    store.credentials[accepting.email.toLowerCase()] = accepting.password;
    store.actingAs = null;
    await saveStore(store);
    await notify('demo-session');
  }
  if (cookies.length) await cookiesChanged(jar, cookies);
  return response;
}

async function notify(type: string): Promise<void> {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type });
}

async function cookiesChanged(jar: CookieJar, cookies: SetCookie[]): Promise<void> {
  const cache = await caches.open('patrice-demo');
  await cache.put(JAR_KEY, new Response(JSON.stringify([...jar])));
  const clients = await self.clients.matchAll({ type: 'window' });
  // The page reads the CSRF cookie itself (double-submit), so mirror readable cookies.
  const readable = cookies.filter((c) => !c.httpOnly);
  for (const c of clients) {
    if (readable.length) c.postMessage({ type: 'demo-cookies', cookies: readable });
    // A new or ended session (login, logout): the demo header shows who you are.
    if (cookies.some((k) => k.name === 'patrice_session')) c.postMessage({ type: 'demo-session' });
  }
}

async function handle(event: FetchEvent): Promise<Response> {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/__demo/')) {
    return handleDemoRequest(event.request, {
      build: __DEMO_BUILD__,
      personas: __DEMO_PERSONAS__,
      running: () => server !== null,
      db: async () => (await getServer()).db,
      loadStore,
      saveStore,
      api: async (method, path, body) => {
        // As the page would send it: JSON, and the CSRF token on writes (double-submit).
        const { jar } = await getServer();
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['content-type'] = 'application/json';
        const csrf = jar.get('patrice_csrf');
        if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
        return viaApi(
          new Request(new URL(path, self.location.origin), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      },
    });
  }
  return viaApi(event.request);
}

// The worker's event listeners live in the small wrapper (demo/sw.js), which loads
// this bundle and calls in here; see the wrapper for why.
/** Close the API and its database, so the page can delete the demo's data. */
async function shutdown(): Promise<void> {
  const running = server;
  server = null;
  if (running) await (await running.catch(() => null))?.close();
}

(self as unknown as { __patriceDemo: unknown }).__patriceDemo = {
  shutdown,
  respond(event: FetchEvent): Promise<Response> {
    return handle(event).catch((e) => {
      console.error('[demo]', e instanceof Error ? e.stack : e);
      return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: String(e) } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
  },
};
