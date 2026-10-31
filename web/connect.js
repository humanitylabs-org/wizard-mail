/* Wizard connect sheet: connect Google or Microsoft from inside Mail or Calendar, without leaving the window.
 * Talks to the source apps' owner routes on this same origin (/wizard-google/, /wizard-microsoft/; see
 * docs/mail-calendar-contract.md "Connecting from another app" in either source app). The Quick connect window is
 * opened from the tap itself (prepared beforehand), on the box's other address so Wizard hands it to the browser,
 * where Google and Microsoft allow sign-in. It signs in to Composio when needed, then Google or Microsoft, and closes
 * by itself while this sheet follows along. Shared by wizard-mail and wizard-calendar (same file). Uses wizard-sheet.js when present. */
(() => {
  'use strict';
  const NOTE = 'Quick connect goes through Composio, a third party. They hold the sign-in keys, so technically they can access ' +
    'this account. Free for normal personal use; heavy use can cost money. You can switch any time.';
  const SOURCES = {
    google: { id: 'google', name: 'Google', path: '/wizard-google/', mail: 'Gmail', calendar: 'Google Calendar',
      own: 'Use your own Google app', ownSub: 'About ten minutes in Google Cloud. Nobody else is involved.' },
    microsoft: { id: 'microsoft', name: 'Microsoft', path: '/wizard-microsoft/', mail: 'Outlook, Hotmail, Microsoft 365', calendar: 'Outlook Calendar',
      own: 'Use your own Microsoft app', ownSub: 'About ten minutes in Microsoft Entra. Nobody else is involved.' },
  };

  function el(tag, text, cls, attrs) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }
  function row(title, sub, onclick, tile, disabled) {
    const r = el('button', null, 'wz-row', { type: 'button' });
    if (disabled) r.disabled = true;
    r.onclick = onclick;
    if (tile) r.append(el('span', tile, 'wz-tile', { 'aria-hidden': 'true' }));
    const main = el('span', null, 'wz-main'); main.append(el('b', title)); if (sub) main.append(el('small', sub));
    r.append(main, el('span', '›', 'chev', { 'aria-hidden': 'true' }));
    return r;
  }

  // ---------- one source app, same origin ----------
  const clients = {};
  function client(src) {
    if (clients[src.id]) return clients[src.id];
    let csrf = null;
    const c = {
      async boot() {
        if (csrf) return;
        const r = await fetch(src.path + 'api/session', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Wizard-Request': 'bootstrap' }, body: '{}' });
        const v = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((v.error && v.error.message) || `The ${src.name} app is not reachable.`);
        csrf = v.csrf;
      },
      async api(p, body) {
        await c.boot();
        const init = body === undefined ? { credentials: 'same-origin' }
          : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) };
        const r = await fetch(src.path + p, init);
        const v = await r.json().catch(() => ({}));
        if (r.status === 401 || r.status === 403) csrf = null;
        if (!r.ok) { const e = new Error((v.error && v.error.message) || `The ${src.name} app could not do that.`); e.code = v.error && v.error.code; throw e; }
        return v;
      },
    };
    clients[src.id] = c;
    return c;
  }

  // ---------- sheets ----------
  // The kit's sheet (wizard-sheet.js) when the app has it; a plain modal dialog otherwise.
  const Sheet = () => window.WzSheet || { open: d => { if (!d.open) d.showModal(); }, close: d => d.close() };
  let dialog = null, onDone = null, purpose = 'mail', polling = null, seq = 0;
  function sheet(title, ...children) {
    if (!dialog) {
      dialog = el('dialog', null, 'wz-sheet wc-sheet', { 'aria-labelledby': 'wc-title' });
      document.body.append(dialog);
      dialog.addEventListener('close', () => { stop(); discard(); });
    }
    dialog.replaceChildren(el('h2', title, null, { id: 'wc-title' }), ...children);
    Sheet().open(dialog);
    return dialog;
  }
  function close() { stop(); if (dialog && dialog.open) Sheet().close(dialog); }
  function stop() { if (polling) { clearInterval(polling); polling = null; } seq++; }

  function open(opts) {
    purpose = opts.purpose === 'calendar' ? 'calendar' : 'mail';
    onDone = opts.onDone || (() => {});
    if (opts.source && SOURCES[opts.source]) return choose(SOURCES[opts.source]);
    const have = opts.available || { google: true, microsoft: true };
    const list = el('div', null, 'wz-list');
    for (const src of Object.values(SOURCES)) {
      list.append(row(src.name, have[src.id] === false ? `Get the ${src.name} app first` : src[purpose], () => choose(src), src.name[0], have[src.id] === false));
    }
    sheet(purpose === 'calendar' ? 'Connect your calendar' : 'Connect your email', list,
      el('p', 'You can add more accounts later, and use both.', 'muted'));
  }

  // Quick connect is prepared while the owner reads the choices, so the tap itself opens the sign-in window: Wizard
  // hands windows for other addresses to the browser, and browsers only allow a window opened inside a tap.
  let prepared = null;
  function prepare(src) {
    const services = src.id === 'google' ? (purpose === 'mail' ? ['gmail', 'calendar'] : ['calendar', 'gmail']) : undefined;
    const p = { src, out: null, error: null, used: false };
    p.ready = client(src).api('api/quick/flow', services ? { services } : {}).then(out => { p.out = out; return out; }, e => { p.error = e; throw e; });
    p.ready.catch(() => {});
    return p;
  }
  function discard() {
    const p = prepared; prepared = null;
    if (p && !p.used) p.ready.then(out => client(p.src).api('api/quick/flow/cancel', { flow: out.flow })).catch(() => {});
  }
  const windowUrl = out => new URL(out.go_out || out.go, location.href).href;
  function openWindow(url) {
    try { window.open(url, '_blank', 'noopener'); } catch (_) { return false; }
    return true;
  }

  function choose(src) {
    discard();
    prepared = prepare(src);
    const list = el('div', null, 'wz-list');
    list.append(row('Quick connect', src.id === 'google' ? 'About a minute, through Composio. Gmail and Calendar together.'
      : 'About a minute, through Composio. Mail and calendar together.', () => quick(src), '✦'));
    list.append(row(src.own, src.ownSub, () => { discard(); own(src); }, '⚙'));
    sheet(`Connect ${src.name}`, list, el('p', NOTE, 'muted wc-note'));
  }

  async function quick(src) {
    const p = prepared && prepared.src === src ? prepared : prepare(src);
    prepared = null;
    p.used = true;
    stop();
    const opened = !!p.out && openWindow(windowUrl(p.out)); // inside the tap: the window opens straight away
    try {
      const out = await p.ready;
      progress(src, out, null, !opened);
      poll(src, out);
    } catch (e) {
      sheet(`Connect ${src.name}`, el('p', e.message, 'wc-bad'), actions(button('Try again', () => choose(src))));
    }
  }

  function button(text, fn, cls = 'wz-button') { const b = el('button', text, cls, { type: 'button' }); b.onclick = fn; return b; }
  function actions(...b) { const a = el('div', null, 'wz-actions'); a.append(...b); return a; }
  function link(text, href, cls) { return el('a', text, cls, { href, target: '_blank', rel: 'noopener' }); }

  function progress(src, out, v, first) {
    const where = v ? v.where : (out.steps && out.steps[0] && out.steps[0].id === 'composio' ? 'composio' : null);
    const text = first ? `Open the sign-in window to connect ${src.name}.`
      : where === 'composio' ? 'In the new window, sign in to Composio or create a free account. Wizard saves the key by itself, then asks ' + src.name + '.'
        : `In the new window, choose your ${src.name} account and allow access${v && v.label ? ` for ${v.label}` : ''}. This updates by itself.`;
    const steps = el('ol', null, 'wc-steps');
    for (const s of ((v || out).steps || [])) {
      const li = el('li', null, s.done ? 'wc-done' : (v && s.id === v.step ? 'wc-now' : ''));
      li.append(el('span', s.done ? '✓' : '', 'wc-dot', { 'aria-hidden': 'true' }), el('span', s.label));
      steps.append(li);
    }
    const url = windowUrl(out);
    sheet(first ? `Connect ${src.name}` : 'Finish in the new window', el('p', text, 'muted'), steps, first ? '' : el('div', null, 'wc-spin', { 'aria-hidden': 'true' }),
      actions(link(first ? 'Open the sign-in window ↗' : 'Open the window again ↗', url, first ? 'wz-button' : 'wz-button secondary'),
        button('Cancel', () => { client(src).api('api/quick/flow/cancel', { flow: out.flow }).catch(() => {}); close(); }, 'wz-button secondary')));
  }

  function poll(src, out) {
    stop();
    const mine = seq;
    let shown = '';
    polling = setInterval(async () => {
      let v;
      try { v = await client(src).api('api/quick/flow?flow=' + encodeURIComponent(out.flow)); } catch { return; }
      if (mine !== seq) return;
      if (v.state === 'done') {
        close();
        onDone({ source: src.id, email: v.result && v.result.email, connected: v.connected });
        return;
      }
      if (v.state !== 'running') {
        stop();
        sheet(`Connect ${src.name}`, el('p', (v.error && v.error.message) || 'The sign-in stopped.', 'wc-bad'), actions(button('Try again', () => choose(src))));
        return;
      }
      const sig = `${v.step}|${v.where}`;
      if (sig !== shown) { shown = sig; progress(src, out, v, false); }
    }, 1500);
  }

  // ---------- your own app: the source app's own setup, inside this window ----------
  function own(src) {
    close();
    const layer = el('div', null, 'wc-layer', { role: 'dialog', 'aria-label': src.own });
    const bar = el('div', null, 'wc-layer-bar');
    const done = button('Done', () => finish(), 'wz-button secondary');
    bar.append(el('b', src.own), done);
    const frame = el('iframe', null, 'wc-frame', { title: src.own, src: src.path + '?start=own' });
    layer.append(bar, frame);
    document.body.append(layer);
    let back = null;
    try { back = window.WizardApp && window.WizardApp.back && window.WizardApp.back.push(() => { finish(true); return true; }); } catch (_) {}
    function finish(fromBack) {
      layer.remove();
      if (back && !fromBack) { try { back.release(); } catch (_) {} }
      onDone({ source: src.id });
    }
  }

  // `client(id)` is the same-origin owner client for one source app (used by Settings for accounts and agent access).
  window.WizardConnect = { open, sources: SOURCES, client: id => client(SOURCES[id]) };
})();
