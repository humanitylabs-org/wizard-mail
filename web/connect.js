/* Wizard connect sheet: connect Google or Microsoft from inside Mail or Calendar, without leaving the window.
 * Talks to the source apps' owner routes on this same origin (/wizard-google/, /wizard-microsoft/; see
 * docs/mail-calendar-contract.md "Connecting from another app" in either source app). The Quick connect popup is
 * opened from the tap itself, so browsers allow it; it signs in to Composio when needed, then Google or Microsoft,
 * and closes by itself. Shared by wizard-mail and wizard-calendar (same file in both). Needs wizard-sheet.js. */
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
  let dialog = null, onDone = null, purpose = 'mail', polling = null, seq = 0;
  function sheet(title, ...children) {
    if (!dialog) {
      dialog = el('dialog', null, 'wz-sheet wc-sheet', { 'aria-labelledby': 'wc-title' });
      document.body.append(dialog);
      dialog.addEventListener('close', () => stop());
    }
    dialog.replaceChildren(el('h2', title, null, { id: 'wc-title' }), ...children);
    window.WzSheet.open(dialog);
    return dialog;
  }
  function close() { stop(); if (dialog && dialog.open) window.WzSheet.close(dialog); }
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

  function choose(src) {
    const list = el('div', null, 'wz-list');
    const also = purpose === 'mail' ? 'calendar' : 'mail';
    let both = true;
    list.append(row('Quick connect', src.id === 'google' ? 'About a minute, through Composio. Gmail and Calendar.'
      : 'About a minute, through Composio. Mail and calendar.', () => quick(src, both), '✦'));
    list.append(row(src.own, src.ownSub, () => own(src), '⚙'));
    const kids = [list];
    if (src.id === 'google') {
      const t = el('button', `Also connect ${also === 'calendar' ? 'Calendar' : 'Gmail'}`, 'wz-chip wc-also', { type: 'button', 'aria-pressed': 'true' });
      t.onclick = () => { both = !both; t.setAttribute('aria-pressed', String(both)); };
      kids.push(el('div', null, 'wc-row'));
      kids[kids.length - 1].append(t);
    }
    kids.push(el('p', NOTE, 'muted wc-note'));
    sheet(`Connect ${src.name}`, ...kids);
  }

  async function quick(src, both) {
    // Open the window inside the tap, before any await, or the browser blocks it.
    const tab = window.open('', '_blank');
    stop();
    const c = client(src);
    const services = src.id === 'google' ? (both ? (purpose === 'mail' ? ['gmail', 'calendar'] : ['calendar', 'gmail']) : [purpose === 'mail' ? 'gmail' : 'calendar']) : undefined;
    try {
      const out = await c.api('api/quick/flow', services ? { services } : {});
      const go = new URL(out.go, location.origin).href;
      if (tab) { tab.opener = null; tab.location.href = go; }
      progress(src, out.flow, go, tab, null);
      poll(src, out.flow, go, tab);
    } catch (e) {
      if (tab) tab.close();
      sheet(`Connect ${src.name}`, el('p', e.message, 'wc-bad'), actions(button('Try again', () => choose(src))));
    }
  }

  function button(text, fn, cls = 'wz-button') { const b = el('button', text, cls, { type: 'button' }); b.onclick = fn; return b; }
  function actions(...b) { const a = el('div', null, 'wz-actions'); a.append(...b); return a; }

  function progress(src, flow, go, tab, v) {
    const where = v && v.where;
    const text = where === 'composio'
      ? 'Sign in to Composio, or create a free account, in the new window. Wizard saves the key by itself.'
      : `Choose your ${src.name} account and allow access${v && v.label ? ` for ${v.label}` : ''}. This updates by itself.`;
    const steps = el('ol', null, 'wc-steps');
    for (const s of (v ? v.steps : [])) {
      const li = el('li', null, s.done ? 'done' : (v && s.id === v.step ? 'now' : ''));
      li.append(el('span', s.done ? '✓' : '', 'wc-dot', { 'aria-hidden': 'true' }), el('span', s.label));
      steps.append(li);
    }
    const shown = tab && !tab.closed;
    sheet('Finish in the new window', el('p', text, 'muted'), steps, el('div', null, 'wc-spin', { 'aria-hidden': 'true' }),
      actions(button(shown ? 'Show the window' : 'Continue', () => { const t = window.open(go, '_blank'); if (t) { t.opener = null; poll(src, flow, go, t); } }, 'wz-button secondary'),
        button('Cancel', () => { client(src).api('api/quick/flow/cancel', { flow }).catch(() => {}); if (tab && !tab.closed) tab.close(); close(); }, 'wz-button secondary')));
  }

  function poll(src, flow, go, tab) {
    stop();
    const mine = seq;
    let where = null, shown = '';
    polling = setInterval(async () => {
      let v;
      try { v = await client(src).api('api/quick/flow?flow=' + encodeURIComponent(flow)); } catch { return; }
      if (mine !== seq) return;
      if (v.state === 'done') {
        if (tab && !tab.closed) tab.close();
        close();
        onDone({ source: src.id, email: v.result && v.result.email, connected: v.connected });
        return;
      }
      if (v.state !== 'running') {
        if (tab && !tab.closed) tab.close();
        stop();
        sheet(`Connect ${src.name}`, el('p', (v.error && v.error.message) || 'The sign-in stopped.', 'wc-bad'), actions(button('Try again', () => choose(src))));
        return;
      }
      // Composio's own page does not send the window back: once the key has landed, point it at the next sign-in.
      if (where === 'composio' && v.where !== 'composio' && tab && !tab.closed) { try { tab.location.href = go; } catch (_) { /* gone */ } }
      where = v.where;
      const sig = `${v.step}|${v.where}|${tab && tab.closed}`;
      if (sig !== shown) { shown = sig; progress(src, flow, go, tab, v); }
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

  window.WizardConnect = { open, sources: SOURCES };
})();
