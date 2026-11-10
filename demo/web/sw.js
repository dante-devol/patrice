// The demo's service worker entry: a small classic script that owns the event
// listeners and loads the real worker (the API bundle, sw-main.js) with importScripts.
//
// Why a wrapper: if the bundle throws while it's evaluated (Firefox did, with DevTools
// attached during startup), a plain worker fails to install and the browser only says
// "threw an exception during script evaluation". Here the error is caught, shown on
// the page (via /api responses), and loading is retried on the next request.
let loadError = null;

function load() {
  if (self.__patriceDemo) return true;
  try {
    importScripts('./sw-main.js');
    loadError = null;
    return !!self.__patriceDemo;
  } catch (e) {
    loadError = (e && (e.stack || e.message)) || String(e);
    console.error('[demo] the worker bundle failed to load:', loadError);
    return false;
  }
}

load();

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// A page that loaded without a controller (a hard reload) asks to be claimed.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'demo-claim') e.waitUntil(self.clients.claim());
  // The start page's "Clear demo data": close the database so it can be deleted, then
  // answer on the port it sent.
  if (e.data && e.data.type === 'demo-shutdown') {
    const reply = e.ports[0];
    e.waitUntil(
      Promise.resolve(self.__patriceDemo && self.__patriceDemo.shutdown())
        .then(() => reply && reply.postMessage({ ok: true }))
        .catch((err) => reply && reply.postMessage({ ok: false, error: String(err) })),
    );
  }
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // The API, and the demo's own endpoints (/__demo/, for the demo header).
  if (url.origin !== self.location.origin || !(url.pathname.startsWith('/api/') || url.pathname.startsWith('/__demo/'))) return;
  if (!load()) {
    event.respondWith(
      new Response(JSON.stringify({ error: { code: 'DEMO_WORKER_FAILED', message: String(loadError) } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    return;
  }
  event.respondWith(self.__patriceDemo.respond(event));
});
