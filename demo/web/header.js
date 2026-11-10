// The demo header: a bar above the app on every demo page, outside Angular (it's
// inserted before <app-root>, in normal flow, so the app's own sticky bar and dialogs
// are untouched). Rendered in a Shadow DOM so the app's styles and the header's can't
// affect each other.
//
// Before the demo is started in this browser it shows only the way back to the main
// site. Once started: a link to the start page, and the user switcher, which shows who
// you are and lets you become anyone the demo knows (demo users, people who joined
// during the demo, pending invitees, or Anonymous), and the inbox: the mail Patrice
// would have sent to whoever you are now, like a single-user mail client.
(() => {
  const HOME_URL = 'https://dante-devol.dev';
  const HOME_LABEL = 'dante-devol.dev';
  const onStartPage = location.pathname === '/demo' || location.pathname === '/demo.html';
  const GROUPS = [
    ['persona', 'Demo users'],
    ['joined', 'Joined during the demo'],
    ['other', 'Signed in through the app'],
    ['invitee', 'Invited (no account yet)'],
    ['anonymous', 'No account'],
  ];

  const css = `
    :host { all: initial; display: block; position: relative; z-index: 60; }
    nav {
      box-sizing: border-box; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      min-height: 40px; padding: 6px 16px; background: #2a2d32; color: #ffffff;
      font: 13px/1.3 'Atkinson Hyperlegible', system-ui, sans-serif;
    }
    a { color: #ffffff; text-decoration: none; border-radius: 2px; }
    a:hover { text-decoration: underline; }
    a:focus-visible, button:focus-visible { outline: 2px solid #9aa6b6; outline-offset: 2px; }
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
    a[aria-current='page'] { color: #a3a7ae; pointer-events: none; }

    .switcher { position: relative; }
    .who {
      display: inline-flex; align-items: center; gap: 7px; max-width: 320px;
      font: inherit; color: #ffffff; background: transparent; cursor: pointer;
      border: 1px solid #43474f; border-radius: 2px; padding: 4px 9px;
    }
    .who:hover { background: #43474f; }
    .who[aria-expanded='true'] { background: #43474f; border-color: #62666e; }
    .who .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who .label .dim { color: #a3a7ae; }
    .caret { color: #a3a7ae; font-size: 10px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #62666e; flex: none; }
    .dot.in { background: #6fbf8e; }

    .menu {
      position: absolute; right: 0; top: calc(100% + 6px); width: 320px; max-height: min(70vh, 520px);
      overflow: auto; background: #ffffff; color: #2a2d32; border: 1px solid #d5d8dd; border-radius: 2px;
      box-shadow: 0 18px 40px -16px rgba(42, 45, 50, 0.45); padding: 6px 0;
    }
    .menu[hidden] { display: none; }
    .group { padding: 8px 14px 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: #62666e; }
    .item {
      display: grid; grid-template-columns: 16px 1fr; gap: 2px 8px; width: 100%; text-align: left;
      font: inherit; color: inherit; background: none; border: 0; padding: 7px 14px; cursor: pointer;
    }
    .item:hover, .item:focus-visible { background: #eef0f3; outline: none; }
    .item[aria-checked='true'] .tick::after { content: '✓'; color: #2d6b50; font-weight: 700; }
    .item .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item .desc { grid-column: 2; font-size: 12px; color: #62666e; }
    .item[aria-disabled='true'] { cursor: default; }
    .item[aria-disabled='true']:hover { background: none; }
    .status { padding: 8px 14px; font-size: 12px; color: #62666e; }
    .error { margin: 6px 10px 2px; padding: 8px 10px; font-size: 12px; color: #8e3b26;
      background: #fbf3f1; border: 1px solid #8e3b26; }
    .error[hidden], .status[hidden] { display: none; }

    .mail { position: relative; }
    .mail-btn {
      display: inline-flex; align-items: center; gap: 7px; font: inherit; color: #ffffff;
      background: transparent; cursor: pointer; border: 1px solid #43474f; border-radius: 2px; padding: 4px 9px;
    }
    .mail-btn:hover, .mail-btn[aria-expanded='true'] { background: #43474f; }
    .badge {
      min-width: 18px; padding: 0 5px; border-radius: 9px; background: #c0563a; color: #ffffff;
      font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
    }
    .badge[hidden] { display: none; }
    .panel {
      position: absolute; right: 0; top: calc(100% + 6px); width: min(760px, calc(100vw - 32px)); height: min(70vh, 540px);
      display: grid; grid-template-columns: 270px 1fr; background: #ffffff; color: #2a2d32;
      border: 1px solid #d5d8dd; border-radius: 2px; box-shadow: 0 18px 40px -16px rgba(42, 45, 50, 0.45); overflow: hidden;
    }
    .panel[hidden] { display: none; }
    .panel.nomail { grid-template-columns: 1fr; height: auto; width: min(360px, calc(100vw - 32px)); }
    .panel.nomail .mlist { display: none; }
    .mlist { border-right: 1px solid #d5d8dd; overflow: auto; }
    .mhead { padding: 10px 14px; border-bottom: 1px solid #d5d8dd; font-size: 12px; color: #62666e; }
    .mhead strong { color: #2a2d32; }
    .msg {
      display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0;
      border-bottom: 1px solid #eef0f3; padding: 9px 14px; cursor: pointer;
    }
    .msg:hover, .msg:focus-visible { background: #f5f6f8; outline: none; }
    .msg[aria-current='true'] { background: #eef0f3; box-shadow: inset 3px 0 0 #2a2d32; }
    .msg .subj { display: block; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg.unread .subj { font-weight: 700; }
    .msg .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #62666e; margin-top: 2px; }
    .msg .prev { display: block; font-size: 12px; color: #62666e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
    .reader { display: flex; flex-direction: column; min-width: 0; }
    .rhead { padding: 12px 16px; border-bottom: 1px solid #d5d8dd; }
    .rhead h2 { margin: 0 0 4px; font: 700 15px/1.3 'Atkinson Hyperlegible', system-ui, sans-serif; }
    .rhead dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 8px; margin: 0; font-size: 12px; color: #62666e; }
    .rhead dt { color: #a3a7ae; }
    .rhead dd { margin: 0; overflow-wrap: anywhere; }
    .tabs { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; }
    .tabs button { font: inherit; background: none; border: 0; padding: 0 0 2px; color: #62666e; cursor: pointer; border-bottom: 2px solid transparent; }
    .tabs button[aria-selected='true'] { color: #2a2d32; font-weight: 700; border-bottom-color: #2a2d32; }
    .tabs button[hidden] { display: none; }
    .body { flex: 1; min-height: 0; }
    .body iframe { width: 100%; height: 100%; border: 0; display: block; background: #ffffff; }
    .body pre { margin: 0; padding: 14px 16px; height: 100%; box-sizing: border-box; overflow: auto;
      font: 13px/1.5 ui-monospace, 'Cascadia Mono', Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { padding: 18px 16px; font-size: 13px; color: #62666e; line-height: 1.5; }
    .empty strong { color: #2a2d32; }
    @media (max-width: 560px) {
      .title-text, .sep { display: none; }
      .menu { position: fixed; left: 8px; right: 8px; width: auto; top: 46px; }
      .panel { position: fixed; left: 8px; right: 8px; top: 46px; width: auto; height: 75vh; grid-template-columns: 1fr; grid-template-rows: 40% 60%; }
      .mlist { border-right: 0; border-bottom: 1px solid #d5d8dd; }
    }
  `;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  class PatriceDemoHeader extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.state = null;
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
            <span class="mail">
              <button class="mail-btn" type="button" aria-expanded="false" aria-controls="inbox">
                Inbox <span class="badge" hidden></span>
              </button>
              <div class="panel" id="inbox" role="dialog" aria-label="Inbox" hidden>
                <div class="mlist"></div>
                <div class="reader"></div>
              </div>
            </span>
            <span class="switcher">
              <button class="who" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="people">
                <span class="dot" aria-hidden="true"></span><span class="label">…</span><span class="caret" aria-hidden="true">▼</span>
              </button>
              <div class="menu" id="people" role="menu" aria-label="Switch user" hidden>
                <div class="error" role="alert" hidden></div>
                <div class="status" hidden></div>
                <div class="list"></div>
              </div>
            </span>
          </span>
        </nav>`;
      this.$ = (sel) => root.querySelector(sel);
      this.$('.who').addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
      this.$('.who').addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.open(e.key === 'ArrowUp' ? 'last' : 'first');
        }
      });
      this.$('.menu').addEventListener('keydown', (e) => this.onMenuKey(e));
      this.$('.mail-btn').addEventListener('click', () => (this.inboxOpen() ? this.closeInbox() : this.openInbox()));
      this.$('.panel').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeInbox();
          this.$('.mail-btn').focus();
        }
      });
      this.$('.mlist').addEventListener('click', (e) => {
        const m = e.target.closest?.('.msg');
        if (m) void this.showMessage(m.dataset.id);
      });
      this.$('.list').addEventListener('click', (e) => {
        const item = e.target.closest?.('.item');
        if (item) void this.choose(item);
      });
      // Close on a click anywhere else, or when focus leaves the switcher.
      document.addEventListener('click', (e) => {
        if (e.composedPath().includes(this)) return;
        if (this.isOpen()) this.close();
        if (this.inboxOpen()) this.closeInbox();
      });
      // The start page says when it has started or cleared the demo.
      window.addEventListener('patrice-demo-changed', () => this.refresh());
      navigator.serviceWorker?.addEventListener('message', (e) => {
        // Signed in or out (through the app or the switcher), or the demo finished starting.
        if (e.data?.type === 'demo-session' || (e.data?.type === 'demo-progress' && e.data.id === 'ready')) this.refresh();
        // Patrice "sent" mail: update the unread count, and the list if it's open.
        if (e.data?.type === 'demo-mail') void this.refresh().then(() => this.inboxOpen() && this.loadInbox());
      });
      this.refresh();
    }

    /** Ask the demo's worker who we are; anything but its JSON means "not started". */
    async refresh({ full = false } = {}) {
      let state = null;
      try {
        const registered = navigator.serviceWorker && (await navigator.serviceWorker.getRegistrations()).length > 0;
        if (registered && navigator.serviceWorker.controller) {
          // On the start page, don't start the API just to draw the header.
          const peek = onStartPage && !full ? '?peek' : '';
          const res = await fetch(`/__demo/state${peek}`, { cache: 'no-store' });
          if ((res.headers.get('content-type') ?? '').includes('application/json')) state = await res.json();
        }
      } catch {
        state = null;
      }
      this.state = state;
      this.$('.started').hidden = !state?.started;
      if (!state?.started) {
        this.closeInbox();
        return this.close();
      }
      this.renderButton();
      this.renderBadge();
      if (this.isOpen()) this.renderList();
    }

    renderButton() {
      const s = this.state;
      const cur = s.current;
      const label = this.$('.who .label');
      this.$('.who .dot').classList.toggle('in', !!s.user);
      if (!s.running) label.innerHTML = 'Choose who to be';
      else if (cur?.kind === 'invitee') label.innerHTML = `<span class="dim">Invitee:</span> ${esc(cur.label)}`;
      else if (cur?.kind === 'anonymous') label.innerHTML = 'Anonymous <span class="dim">(signed out)</span>';
      else label.innerHTML = `<span class="dim">Viewing as</span> ${esc(cur?.label ?? s.user?.displayName ?? '…')}`;
      this.$('.who').setAttribute('aria-label', `Switch user (now: ${label.textContent})`);
    }

    renderList() {
      const people = this.state?.people ?? [];
      const list = this.$('.list');
      list.innerHTML = GROUPS.map(([kind, title]) => {
        const group = people.filter((p) => p.kind === kind);
        if (!group.length) return '';
        return (
          `<div class="group" role="presentation">${esc(title)}</div>` +
          group
            .map(
              (p) => `<button class="item" type="button" role="menuitemradio" tabindex="-1"
                  data-key="${esc(p.key)}" aria-checked="${p.current}"${p.switchable ? '' : ' aria-disabled="true"'}>
                <span class="tick" aria-hidden="true"></span>
                <span class="name">${esc(p.label)}</span>
                <span class="desc">${esc(p.email && p.email !== p.label ? `${p.email} · ${p.description}` : p.description)}</span>
              </button>`,
            )
            .join('')
        );
      }).join('');
    }

    isOpen() {
      return !this.$('.menu').hidden;
    }

    async open(focus = 'current') {
      this.closeInbox();
      this.$('.error').hidden = true;
      this.$('.menu').hidden = false;
      this.$('.who').setAttribute('aria-expanded', 'true');
      // The full list (pending invitations change as you use the app); this also starts
      // the API if it isn't running yet (the start page).
      const status = this.$('.status');
      status.textContent = 'Loading…';
      status.hidden = !!this.state?.people?.length;
      if (this.state?.people?.length) this.renderList();
      const menu = this.$('.menu');
      menu.setAttribute('aria-busy', 'true');
      await this.refresh({ full: true });
      menu.removeAttribute('aria-busy');
      status.hidden = true;
      this.renderList();
      const items = this.items();
      const target = focus === 'first' ? items[0] : focus === 'last' ? items.at(-1) : items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0];
      target?.focus();
    }

    close() {
      this.$('.menu').hidden = true;
      this.$('.who').setAttribute('aria-expanded', 'false');
    }

    items() {
      return [...this.shadowRoot.querySelectorAll('.item:not([aria-disabled="true"])')];
    }

    onMenuKey(e) {
      const items = this.items();
      const at = items.indexOf(this.shadowRoot.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        this.$('.who').focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        (e.key === 'Home' ? items[0] : items.at(-1))?.focus();
      } else if (e.key === 'Tab') {
        this.close();
      }
    }

    renderBadge() {
      const badge = this.$('.badge');
      const unread = this.state?.inbox?.unread ?? 0;
      badge.textContent = String(unread);
      badge.hidden = unread === 0;
      this.$('.mail-btn').setAttribute('aria-label', unread ? `Inbox, ${unread} unread` : 'Inbox');
    }

    inboxOpen() {
      return !!this.$('.panel') && !this.$('.panel').hidden;
    }

    async openInbox() {
      this.close();
      this.$('.panel').hidden = false;
      this.$('.mail-btn').setAttribute('aria-expanded', 'true');
      await this.loadInbox();
      this.$('.msg')?.focus();
    }

    closeInbox() {
      if (!this.$('.panel')) return;
      this.$('.panel').hidden = true;
      this.$('.mail-btn').setAttribute('aria-expanded', 'false');
    }

    /** The current person's mail. Anonymous has no address, so no mailbox. */
    async loadInbox() {
      const list = this.$('.mlist');
      const reader = this.$('.reader');
      const panel = this.$('.panel');
      panel.setAttribute('aria-busy', 'true');
      let data = null;
      try {
        data = await (await fetch('/__demo/inbox', { cache: 'no-store' })).json();
      } catch {
        data = null;
      }
      panel.removeAttribute('aria-busy');
      this.inbox = data;
      panel.classList.toggle('nomail', !data?.addresses?.length);
      if (!data?.addresses?.length) {
        list.innerHTML = '';
        reader.innerHTML = `<div class="empty"><strong>Anonymous has no mailbox.</strong><br>
          Choose someone with an email address from the user menu to read their mail.</div>`;
        return;
      }
      const head = `<div class="mhead">Mail for <strong>${esc(data.addresses[0])}</strong>${
        data.addresses.length > 1 ? ` and ${esc(data.addresses.slice(1).join(', '))}` : ''
      }</div>`;
      if (!data.messages.length) {
        list.innerHTML = head;
        reader.innerHTML = `<div class="empty"><strong>No mail yet.</strong><br>
          Patrice sends mail to verify an email address, reset a password, or confirm a
          change of email. It arrives here for whoever it's addressed to.</div>`;
        return;
      }
      const when = (iso) =>
        new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      list.innerHTML =
        head +
        data.messages
          .map(
            (m) => `<button class="msg${m.read ? '' : ' unread'}" type="button" data-id="${esc(m.id)}"
                aria-current="${m.id === this.openMessage}">
              <span class="subj">${esc(m.subject)}</span>
              <span class="meta"><span>${esc(m.from.replace(/\s*<.*$/, ''))}</span><span>${esc(when(m.date))}</span></span>
              <span class="prev">${esc(m.preview)}</span>
            </button>`,
          )
          .join('');
      if (!data.messages.some((m) => m.id === this.openMessage)) {
        this.openMessage = null;
        reader.innerHTML = `<div class="empty">Select a message to read it.</div>`;
      }
    }

    /** One message: its HTML in a sandboxed frame (no scripts); links open in the page. */
    async showMessage(id) {
      const reader = this.$('.reader');
      const res = await fetch(`/__demo/inbox/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const m = await res.json();
      this.openMessage = id;
      reader.innerHTML = `
        <div class="rhead">
          <h2>${esc(m.subject)}</h2>
          <dl><dt>From</dt><dd>${esc(m.from)}</dd><dt>To</dt><dd>${esc(m.to)}</dd>
            <dt>Date</dt><dd>${esc(new Date(m.date).toLocaleString())}</dd></dl>
          <div class="tabs" role="tablist">
            <button type="button" role="tab" data-view="html" aria-selected="${!!m.html}"${m.html ? '' : ' hidden'}>HTML</button>
            <button type="button" role="tab" data-view="text" aria-selected="${!m.html}">Text</button>
          </div>
        </div>
        <div class="body"></div>`;
      const body = reader.querySelector('.body');
      const show = (view) => {
        reader.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
        body.innerHTML = '';
        if (view === 'html') {
          const frame = document.createElement('iframe');
          frame.title = m.subject;
          // No scripts, no same-origin access; a clicked link may take the page there.
          frame.setAttribute('sandbox', 'allow-top-navigation-by-user-activation allow-popups');
          frame.srcdoc =
            '<!doctype html><base target="_top"><style>body{font:14px/1.5 system-ui,sans-serif;color:#2a2d32;' +
            'margin:16px;overflow-wrap:anywhere}a{color:#3f5fb5}</style>' +
            m.html;
          body.append(frame);
        } else {
          body.append(Object.assign(document.createElement('pre'), { textContent: m.text }));
        }
      };
      reader.querySelector('.tabs').addEventListener('click', (e) => {
        const view = e.target.closest?.('button')?.dataset.view;
        if (view) show(view);
      });
      show(m.html ? 'html' : 'text');
      // Read now: the list's bold and the badge.
      this.$('.mlist').querySelectorAll('.msg').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === id)));
      this.$(`.msg[data-id="${CSS.escape(id)}"]`)?.classList.remove('unread');
      await this.refresh();
    }

    /** Become someone: the worker signs in or out through the app, then the page reloads. */
    async choose(item) {
      if (item.getAttribute('aria-disabled') === 'true') return;
      if (item.getAttribute('aria-checked') === 'true') return this.close();
      const error = this.$('.error');
      error.hidden = true;
      const status = this.$('.status');
      status.textContent = `Switching to ${item.querySelector('.name').textContent}…`;
      status.hidden = false;
      try {
        const res = await fetch('/__demo/switch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: item.dataset.key }),
        });
        if (res.ok) {
          // Into the app as the new person; nothing stale stays on screen.
          location.assign('/home');
          return;
        }
        const body = await res.json().catch(() => null);
        error.textContent = `Couldn't switch: ${body?.error?.message ?? `the demo answered ${res.status}`}`;
      } catch (e) {
        error.textContent = `Couldn't switch: ${e?.message ?? e}`;
      }
      status.hidden = true;
      error.hidden = false;
      await this.refresh({ full: true });
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
