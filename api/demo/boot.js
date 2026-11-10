// Browser demo boot: make sure the service worker that runs the API controls this page
// before Angular starts, and mirror the cookies it sets that the page must read (the
// CSRF token). The assembly step moves Angular's module scripts into DEMO_SCRIPTS.
(async () => {
  // Not started in this browser yet (no local server), or asked to reset: the start
  // page explains the demo, sets it up, and comes back here.
  const registered = 'serviceWorker' in navigator && (await navigator.serviceWorker.getRegistrations()).length > 0;
  if (!registered || new URLSearchParams(location.search).has('reset-demo')) {
    const here = location.pathname + location.search;
    const next = here === '/' || here.includes('reset-demo') ? '' : `?next=${encodeURIComponent(here)}`;
    location.replace(`/demo${next}`);
    return;
  }

  const note = document.createElement('div');
  note.textContent = 'Starting the Patrice demo…';
  note.style.cssText = 'position:fixed;inset:auto 0 0 0;padding:8px 12px;font:13px system-ui;background:#2a2d32;color:#fff;z-index:9999';
  document.documentElement.appendChild(note);

  // Where startup has got to, from this page and from the worker ("demo-progress").
  const t0 = performance.now();
  let stage = '';
  const step = (s) => {
    stage = s;
    note.textContent = `Starting the Patrice demo… ${s}`;
    console.log(`[demo] page: ${s} (${Math.round(performance.now() - t0)} ms)`);
  };

  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'demo-progress') step(`(worker) ${e.data.stage}`);
    if (e.data?.type !== 'demo-cookies') return;
    for (const c of e.data.cookies) {
      document.cookie = c.remove
        ? `${c.name}=; Max-Age=0; Path=/`
        : `${c.name}=${encodeURIComponent(c.value)}; Path=/; SameSite=Lax`;
    }
  });

  const fail = (msg) => {
    note.textContent = `The Patrice demo couldn't start: ${msg} (last step: ${stage}). Reload to try again, or open /?reset-demo.`;
    note.style.background = '#8a2b1f';
    console.error(`[demo] ${note.textContent}`);
  };

  step('registering the service worker');
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (!navigator.serviceWorker.controller) {
    step('waiting for the service worker to take control');
    const controlled = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    // An already-active worker doesn't claim a page that loaded without it (a hard
    // reload, Ctrl+Shift+R), so no controllerchange would ever come. Ask it to.
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) reg.active?.postMessage({ type: 'demo-claim' });
    const ok = await Promise.race([controlled.then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))]);
    if (!ok && !navigator.serviceWorker.controller) return fail('the service worker did not take control');
  }
  // Warm the API (first visit loads the database) before the app's first request.
  step('waiting for the API');
  // A network error here is usually the page navigating away (the browser aborts its
  // requests), so retry a few times before calling it a failure.
  const check = async () => {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch('/api/health');
        return r.ok ? true : ((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
      } catch (e) {
        if (i >= 3) return String(e);
        await new Promise((r) => setTimeout(r, 750));
      }
    }
  };
  const health = await Promise.race([check(), new Promise((r) => setTimeout(() => r(null), 30000))]);
  if (health === null) return fail('the API did not answer within 30 seconds');
  if (health !== true) return fail(`the API reported an error: ${String(health).split('\n')[0]}`);
  step('API answered; loading the app');
  note.remove();
  // In order: polyfills (Zone.js) must run before main.
  for (const src of window.DEMO_SCRIPTS ?? []) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.body.appendChild(s);
    });
  }
})();
