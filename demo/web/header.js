// The demo header: a bar above the app on every demo page, outside Angular (it's
// inserted before <app-root>, in normal flow, so the app's own sticky bar and dialogs
// are untouched). Rendered in a Shadow DOM so the app's styles and the header's can't
// affect each other.
//
// Before the demo is started in this browser it shows only the way back to the main
// site. Once started: a link to the start page and who you're signed in as. The user
// switcher (phase 3) and inbox (phase 4) go here too.
(() => {
  const HOME_URL = 'https://dante-devol.dev';
  const HOME_LABEL = 'dante-devol.dev';
  const onStartPage = location.pathname === '/demo' || location.pathname === '/demo.html';

  const css = `
    :host { all: initial; display: block; }
    nav {
      box-sizing: border-box; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      min-height: 40px; padding: 6px 16px; background: #2a2d32; color: #ffffff;
      font: 13px/1.3 'Atkinson Hyperlegible', system-ui, sans-serif;
    }
    a { color: #ffffff; text-decoration: none; border-radius: 2px; }
    a:hover { text-decoration: underline; }
    a:focus-visible { outline: 2px solid #9aa6b6; outline-offset: 2px; }
    .home { display: inline-flex; align-items: center; gap: 6px; color: #d5d8dd; }
    .home:hover { color: #ffffff; }
    .title { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; }
    .chip {
      font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 1px 6px; border: 1px solid #62666e; border-radius: 2px; color: #d5d8dd;
    }
    .sep { width: 1px; height: 18px; background: #43474f; }
    .spacer { flex: 1; }
    .started { display: contents; }
    .started[hidden] { display: none; }
    .user { display: inline-flex; align-items: center; gap: 7px; color: #d5d8dd; }
    .user strong { color: #ffffff; font-weight: 700; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #62666e; flex: none; }
    .user.in .dot { background: #6fbf8e; }
    a[aria-current='page'] { color: #a3a7ae; pointer-events: none; }
    @media (max-width: 560px) { .title-text, .sep { display: none; } }
  `;

  class PatriceDemoHeader extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>${css}</style>
        <nav aria-label="Demo">
          <a class="home" href="${HOME_URL}" title="Back to ${HOME_LABEL}"><span aria-hidden="true">←</span> ${HOME_LABEL}</a>
          <span class="sep" aria-hidden="true"></span>
          <span class="title"><span class="title-text">Patrice</span><span class="chip">Demo</span></span>
          <span class="spacer"></span>
          <span class="started" hidden>
            <a class="start" href="/demo"${onStartPage ? ' aria-current="page"' : ''}>Start page</a>
            <span class="sep" aria-hidden="true"></span>
            <span class="user" aria-live="polite"><span class="dot" aria-hidden="true"></span><span class="who">…</span></span>
          </span>
        </nav>`;
      this.refresh();
      // The start page says when it has started or cleared the demo.
      window.addEventListener('patrice-demo-changed', () => this.refresh());
      navigator.serviceWorker?.addEventListener('message', (e) => {
        // Signed in or out through the app, or the demo just finished starting.
        if (e.data?.type === 'demo-session' || (e.data?.type === 'demo-progress' && e.data.id === 'ready')) this.refresh();
      });
    }

    /** Ask the demo's worker who we are; anything but its JSON means "not started". */
    async refresh() {
      const root = this.shadowRoot;
      const started = root.querySelector('.started');
      let state = null;
      try {
        const registered = navigator.serviceWorker && (await navigator.serviceWorker.getRegistrations()).length > 0;
        if (registered && navigator.serviceWorker.controller) {
          const res = await fetch(`/__demo/state${onStartPage ? '?peek' : ''}`, { cache: 'no-store' });
          if ((res.headers.get('content-type') ?? '').includes('application/json')) state = await res.json();
        }
      } catch {
        state = null;
      }
      started.hidden = !state?.started;
      if (!state?.started) return;
      const user = root.querySelector('.user');
      const who = root.querySelector('.who');
      if (state.user) {
        user.classList.add('in');
        who.innerHTML = '';
        who.append('Signed in as ', Object.assign(document.createElement('strong'), { textContent: state.user.displayName }));
      } else {
        user.classList.remove('in');
        who.textContent = state.running ? 'Not signed in' : 'Demo ready';
      }
    }
  }

  if (!customElements.get('patrice-demo-header')) customElements.define('patrice-demo-header', PatriceDemoHeader);
  const mount = () => {
    if (document.querySelector('patrice-demo-header')) return;
    document.body.prepend(document.createElement('patrice-demo-header'));
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
