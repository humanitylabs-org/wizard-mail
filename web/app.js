/* Wizard Mail: one inbox for the Google and Microsoft accounts on this Wizard.
 * Reads through this app's API (which asks the Google and Microsoft apps); connects new accounts with
 * WizardConnect (connect.js) without leaving the window. Mail is other people's text: it is shown, never run. */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const root = $('.wm');
  const listEl = $('.wm-list'), reader = $('.wm-reader'), toast = $('.wm-toast');
  const FOLDERS = [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['archive', 'Archive'], ['trash', 'Trash']];
  const state = { accounts: null, scope: 'all', folder: 'inbox', q: '', messages: [], cursor: null, open: null, view: 'list', loading: 0, lastLoad: 0, compose: null };

  // ---------- small helpers ----------
  function el(tag, text, cls, attrs) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    return n;
  }
  function button(text, fn, cls = 'wz-button', attrs) { const b = el('button', text, cls, { type: 'button', ...attrs }); b.onclick = fn; return b; }
  let toastTimer = null;
  function say(text, undo) {
    toast.replaceChildren(el('span', text));
    if (undo) toast.append(button('Undo', () => { toast.textContent = ''; undo(); }, 'wm-undo'));
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('on'); toast.textContent = ''; }, undo ? 6000 : 3500);
  }
  async function api(path, body) {
    const init = body === undefined ? { headers: { 'X-Wizard-Request': 'mail' } }
      : { method: 'POST', headers: { 'X-Wizard-Request': 'mail', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(path, { credentials: 'same-origin', ...init });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((v.error && v.error.message) || 'Mail could not do that.'); e.code = v.error && v.error.code; throw e; }
    return v;
  }
  function who(p) { return p ? (p.name || p.email || '') : ''; }
  function initial(text) { return (String(text || '?').trim()[0] || '?').toUpperCase(); }
  function when(iso, long) {
    const d = new Date(iso || '');
    if (isNaN(d)) return '';
    const now = new Date();
    if (long) return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function mailAccounts() { return state.accounts ? state.accounts.sources.flatMap(s => s.accounts).filter(a => a.mail && a.status === 'active') : []; }
  function accountName(key) { const a = mailAccounts().find(x => x.key === key); return a ? (a.label || a.email) : 'All inboxes'; }
  function narrow() { return root.clientWidth < 720; }
  function setView(v) { state.view = v; root.dataset.view = v; }

  // ---------- Back: reader -> list (phone); sheets and layers register their own ----------
  if (window.WizardApp && window.WizardApp.version === 1) {
    window.WizardApp.ready({ name: 'wizard-mail', version: '0.1.5' });
    window.WizardApp.back.register({
      canGoBack: () => state.view === 'reader' && narrow(),
      back: () => { if (!(state.view === 'reader' && narrow())) return false; closeReader(); return true; },
    });
  }

  // ---------- accounts and connect ----------
  async function loadAccounts() {
    state.accounts = await api('api/accounts');
    renderSide();
    const connected = mailAccounts().length > 0;
    $('.wm-connect').hidden = connected;
    root.classList.toggle('wm-empty-box', !connected);
    if (!connected) renderConnect();
    const attention = state.accounts.needs_attention || [];
    const banner = $('.wm-banner');
    banner.hidden = !attention.length;
    banner.replaceChildren();
    if (attention.length) {
      banner.append(el('span', `${attention.map(a => a.email).join(', ')} needs a new sign-in.`), button('Fix', () => connect(attention[0].source), 'wz-button secondary small'));
    }
    if (state.scope !== 'all' && !mailAccounts().some(a => a.key === state.scope)) state.scope = 'all';
    return connected;
  }
  function available() {
    const out = {};
    for (const s of (state.accounts ? state.accounts.sources : [])) out[s.id] = s.available;
    return out;
  }
  function connect(source, backToSettings) {
    window.WizardConnect.open({ purpose: 'mail', source, available: available(), onDone: async result => {
      if (result && result.email) say(`Connected ${result.email}.`);
      if (await loadAccounts().catch(() => false)) load(true);
      if (backToSettings) openSettings();
    } });
  }
  // Settings (settings.js): connected accounts and what agents may do with mail, modelled on Messenger's.
  function openSettings() {
    window.WizardMailSettings.open({
      accounts: () => state.accounts, say,
      connect: source => connect(source, true),
      changed: async () => { if (await loadAccounts().catch(() => false)) load(true); else { state.messages = []; renderList(); } },
    });
  }
  function renderConnect() {
    const box = $('.wm-connect');
    const card = el('div', null, 'wm-hello');
    card.append(el('span', '✉', 'wz-tile wm-hello-tile', { 'aria-hidden': 'true' }), el('h2', 'Connect your email'),
      el('p', 'Choose where your mail lives. You sign in once in a small window; Mail does the rest.', 'muted'));
    const list = el('div', null, 'wz-list wm-hello-list');
    for (const s of (state.accounts ? state.accounts.sources : [])) {
      const src = window.WizardConnect.sources[s.id];
      const r = el('button', null, 'wz-row', { type: 'button' });
      r.disabled = !s.available;
      r.onclick = () => connect(s.id);
      const main = el('span', null, 'wz-main');
      main.append(el('b', s.name), el('small', s.available ? src.mail : `Get the ${s.name} app first`));
      r.append(el('span', s.name[0], 'wz-tile', { 'aria-hidden': 'true' }), main, el('span', '›', 'chev', { 'aria-hidden': 'true' }));
      list.append(r);
    }
    card.append(list);
    box.replaceChildren(card);
  }

  // ---------- side and folder chips ----------
  function renderSide() {
    const nav = $('.wm-nav-accounts');
    nav.replaceChildren();
    const accounts = mailAccounts();
    const all = button('All inboxes', () => pickScope('all'), 'wm-navitem' + (state.scope === 'all' ? ' on' : ''));
    nav.append(all);
    for (const a of accounts) {
      const b = button('', () => pickScope(a.key), 'wm-navitem' + (state.scope === a.key ? ' on' : ''));
      const text = el('span', null, 'wm-navtext');
      text.append(el('b', a.label || (a.source === 'google' ? 'Google' : 'Microsoft')), el('small', a.email));
      b.append(el('span', initial(a.label || (a.source === 'google' ? 'G' : 'M')), 'wm-dot', { 'aria-hidden': 'true' }), text);
      nav.append(b);
    }
    const folders = $('.wm-nav-folders');
    folders.replaceChildren(...FOLDERS.map(([id, label]) => button(label, () => pickFolder(id), 'wm-navitem' + (state.folder === id ? ' on' : ''))));
    $('.wm-folders').replaceChildren(...FOLDERS.map(([id, label]) => button(label, () => pickFolder(id), 'wz-chip wm-fchip', { role: 'tab', 'aria-selected': String(state.folder === id) })));
    $('.wm-scope').textContent = accountName(state.scope) + (accounts.length > 1 ? ' ▾' : '');
  }
  function pickScope(key) { state.scope = key; closeSheet(); renderSide(); load(true); }
  function pickFolder(id) { state.folder = id; renderSide(); load(true); }
  let sheet = null;
  function openSheet(title, ...children) {
    if (!sheet) { sheet = el('dialog', null, 'wz-sheet wm-sheet', { 'aria-label': title }); document.body.append(sheet); }
    sheet.setAttribute('aria-label', title);
    sheet.replaceChildren(el('h2', title), ...children);
    window.WzSheet.open(sheet);
  }
  function closeSheet() { if (sheet && sheet.open) window.WzSheet.close(sheet); }
  function scopeSheet() {
    const list = el('div', null, 'wz-list');
    const add = (key, title, sub) => {
      const r = button('', () => pickScope(key), 'wz-row');
      const main = el('span', null, 'wz-main'); main.append(el('b', title)); if (sub) main.append(el('small', sub));
      r.append(el('span', key === 'all' ? '✉' : initial(title), 'wz-tile', { 'aria-hidden': 'true' }), main, el('span', state.scope === key ? '✓' : '', 'chev'));
      list.append(r);
    };
    add('all', 'All inboxes', `${mailAccounts().length} accounts`);
    for (const a of mailAccounts()) add(a.key, a.label || a.email, `${a.source === 'google' ? 'Google' : 'Microsoft'}${a.label ? ' · ' + a.email : ''}`);
    openSheet('Show mail from', list, button('+ Add account', () => { closeSheet(); connect(); }, 'wz-button secondary'));
  }

  // ---------- list ----------
  async function load(fresh) {
    if (!mailAccounts().length) return;
    const mine = ++state.loading;
    if (fresh) { state.cursor = null; listEl.replaceChildren(el('div', 'Loading…', 'wm-loading')); }
    const qs = new URLSearchParams({ account: state.scope, folder: state.folder });
    if (state.q) qs.set('q', state.q);
    if (!fresh && state.cursor) qs.set('cursor', state.cursor);
    try {
      const v = await api('api/messages?' + qs);
      if (mine !== state.loading) return;
      state.messages = fresh ? v.messages : state.messages.concat(v.messages);
      state.cursor = v.cursor;
      state.lastLoad = Date.now();
      renderList();
      if (v.errors && v.errors.length) say(`${v.errors[0].email}: ${v.errors[0].message}`);
    } catch (e) {
      if (mine !== state.loading) return;
      listEl.replaceChildren(el('div', null, 'wz-empty'));
      listEl.firstChild.append(el('strong', 'Mail did not load'), el('p', e.message), button('Try again', () => load(true), 'wz-button secondary'));
    }
  }
  function renderList() {
    $('.wm-more').hidden = !state.cursor;
    if (!state.messages.length) {
      const empty = el('div', null, 'wz-empty');
      empty.append(el('strong', state.q ? 'Nothing matches' : 'Nothing here'), el('p', state.q ? 'Try other words.' : 'New mail shows up here.'));
      listEl.replaceChildren(empty);
      return;
    }
    const many = mailAccounts().length > 1 && state.scope === 'all';
    listEl.replaceChildren(...state.messages.map(m => item(m, many)));
  }
  function item(m, many) {
    const sent = state.folder === 'sent' || state.folder === 'drafts';
    const name = sent ? (m.to && m.to.length ? 'To ' + m.to.map(who).join(', ') : '(no recipient)') : (who(m.from) || '(unknown sender)');
    const b = el('button', null, 'wm-item' + (m.unread ? ' unread' : '') + (state.open && state.open.id === m.id ? ' on' : ''), { type: 'button', role: 'listitem' });
    b.onclick = () => openMessage(m);
    const top = el('span', null, 'wm-line');
    top.append(el('b', name, 'wm-from'), el('time', when(m.date), 'wm-when', { datetime: m.date || '' }));
    const subj = el('span', m.subject || '(no subject)', 'wm-subj');
    const snip = el('span', m.snippet || '', 'wm-snip');
    b.append(el('span', initial(name.replace(/^To /, '')), 'wz-tile wm-avatar', { 'aria-hidden': 'true' }));
    const main = el('span', null, 'wm-itemmain');
    main.append(top, subj, snip);
    if (many) main.append(el('span', m.account_email, 'wm-acct'));
    b.append(main);
    if (m.unread) b.append(el('span', '', 'wm-unread', { 'aria-label': 'Unread' }));
    return b;
  }

  // ---------- reader ----------
  let frameObserver = null;
  function closeReader() {
    state.open = null;
    if (frameObserver) { frameObserver.disconnect(); frameObserver = null; }
    reader.replaceChildren(el('div', null, 'wm-placeholder'));
    reader.firstChild.append(el('span', '✉', 'wz-tile', { 'aria-hidden': 'true' }), el('p', 'Choose a message to read it.'));
    setView('list');
    for (const n of listEl.querySelectorAll('.wm-item.on')) n.classList.remove('on');
  }
  async function openMessage(m, images) {
    state.open = { id: m.id, account: m.account, summary: m };
    renderList();
    setView('reader');
    reader.replaceChildren(el('div', 'Opening…', 'wm-loading'));
    let v;
    try {
      v = await api(`api/message?${new URLSearchParams({ account: m.account, id: m.id, images: images ? '1' : '0' })}`);
    } catch (e) {
      reader.replaceChildren(el('div', null, 'wz-empty'));
      reader.firstChild.append(el('strong', 'This message did not open'), el('p', e.message));
      return;
    }
    if (!state.open || state.open.id !== m.id) return;
    state.open.full = v;
    renderReader(m, v);
    if (m.unread && state.folder !== 'drafts') {
      m.unread = false;
      renderList();
      api('api/update', { account: m.account, id: m.id, read: true }).catch(() => {});
    }
  }
  function renderReader(m, v) {
    const msg = v.message;
    const bar = el('div', null, 'wm-rbar');
    bar.append(button('‹ Back', closeReader, 'wm-icon wm-back', { 'aria-label': 'Back to the list' }));
    bar.append(el('span', null, 'wm-grow'));
    if (state.folder === 'drafts') {
      bar.append(button('Edit and send', () => compose({ mode: 'draft', from: m.account, msg }), 'wz-button'));
    } else {
      bar.append(button('Reply', () => compose({ mode: 'reply', from: m.account, msg }), 'wz-button'),
        button('Reply all', () => compose({ mode: 'all', from: m.account, msg }), 'wz-button secondary'),
        button('Forward', () => compose({ mode: 'forward', from: m.account, msg }), 'wz-button secondary'));
    }
    const more = el('div', null, 'wm-ractions');
    if (state.folder !== 'archive' && state.folder !== 'trash' && state.folder !== 'drafts' && state.folder !== 'sent') more.append(button('Archive', () => change(m, { archived: true }, 'Archived', { archived: false }), 'wz-chip'));
    if (state.folder === 'trash') more.append(button('Move to Inbox', () => change(m, { trashed: false }, 'Moved to Inbox', { trashed: true }), 'wz-chip'));
    else more.append(button('Delete', () => change(m, { trashed: true }, 'Moved to Trash', { trashed: false }), 'wz-chip'));
    if (state.folder !== 'drafts') more.append(button('Mark unread', () => markUnread(m), 'wz-chip'));
    const head = el('header', null, 'wm-rhead');
    head.append(el('h2', msg.subject || '(no subject)', 'wm-rsubj'));
    const from = el('div', null, 'wm-rfrom');
    from.append(el('span', initial(who(msg.from)), 'wz-tile', { 'aria-hidden': 'true' }));
    const lines = el('div', null, 'wm-rpeople');
    const sender = el('b', who(msg.from) || '(unknown sender)');
    lines.append(sender);
    if (msg.from && msg.from.email && msg.from.name) lines.append(el('small', msg.from.email, 'wm-addr'));
    const to = [...(msg.to || []), ...(msg.cc || [])].map(who).filter(Boolean);
    const mine = [...(msg.to || []), ...(msg.cc || [])].some(p => (p.email || '').toLowerCase() === msg.account_email);
    lines.append(el('small', (to.length ? 'To ' + to.join(', ') : '') + (msg.account_email && !mine && mailAccounts().length > 1 ? `  ·  in ${msg.account_email}` : ''), 'wm-rto'));
    from.append(lines, el('time', when(msg.date, true), 'wm-rwhen', { datetime: msg.date || '' }));
    head.append(from, more);
    const body = el('div', null, 'wm-rbody');
    if (v.images_blocked && !v.images_shown) {
      const note = el('div', null, 'wm-imgnote');
      note.append(el('span', 'Pictures from the internet are hidden, so the sender can\'t see that you opened this.'),
        button('Show pictures', () => openMessage(m, true), 'wz-button secondary small'));
      body.append(note);
    }
    if (v.html) body.append(htmlFrame(v.html, v.images_shown));
    else body.append(el('div', msg.body_text || '', 'wm-text'));
    if (msg.truncated) body.append(el('p', 'This message is long; the end is cut off.', 'muted'));
    if (msg.attachments && msg.attachments.length) {
      const att = el('ul', null, 'wm-att');
      for (const a of msg.attachments) att.append(el('li', `📎 ${a.name}${a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : ''}`));
      body.append(att);
    }
    reader.replaceChildren(bar, head, body);
    reader.scrollTop = 0;
  }
  function htmlFrame(html, images) {
    // No scripts, no forms, no top navigation; same-origin only so this page can size the frame to its content.
    const csp = `default-src 'none'; img-src data:${images ? ' https:' : ''}; style-src 'unsafe-inline'; font-src data:`;
    const frame = el('iframe', null, 'wm-frame', { title: 'Message', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
      '<meta name="referrer" content="no-referrer"><base target="_blank"><style>html{color-scheme:light}body{margin:0;padding:18px 20px;background:Canvas;color:CanvasText;' +
      'font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%!important}' +
      'pre{white-space:pre-wrap}.wm-alt{display:inline-block;opacity:.6;font-size:.85em;border:1px dashed GrayText;padding:0 .3em;border-radius:3px}</style></head><body>' +
      html + '</body></html>';
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const fit = () => { frame.style.height = Math.max(120, doc.documentElement.scrollHeight) + 'px'; };
      fit();
      if (frameObserver) frameObserver.disconnect();
      frameObserver = new ResizeObserver(fit);
      frameObserver.observe(doc.documentElement);
      for (const img of doc.images) img.addEventListener('load', fit);
    });
    return frame;
  }

  // ---------- changes (each one leaves the message and offers Undo) ----------
  async function change(m, flags, done, undoFlags) {
    const at = state.messages.indexOf(m);
    state.messages = state.messages.filter(x => x !== m);
    renderList();
    closeReader();
    try {
      const out = await api('api/update', { account: m.account, id: m.id, ...flags });
      const id = out.id || m.id;
      say(done, async () => {
        try {
          await api('api/update', { account: m.account, id, ...undoFlags });
          state.messages.splice(Math.max(0, at), 0, { ...m, id });
          renderList();
        } catch (e) { say(e.message); }
      });
    } catch (e) {
      state.messages.splice(Math.max(0, at), 0, m);
      renderList();
      say(e.message);
    }
  }
  async function markUnread(m) {
    m.unread = true;
    renderList();
    closeReader();
    try { await api('api/update', { account: m.account, id: m.id, read: false }); say('Marked unread'); }
    catch (e) { say(e.message); }
  }

  // ---------- compose ----------
  const EMAIL = /^[^@\s<>,;"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
  function parseAddresses(text) {
    const out = [], bad = [];
    for (const part of String(text || '').split(/[,;\n]/)) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/<([^>]+)>/);
      const a = (m ? m[1] : t).trim();
      (EMAIL.test(a) ? out : bad).push(a);
    }
    return { out, bad };
  }
  function quote(msg) {
    const text = String(msg.body_text || '').split('\n').map(l => '> ' + l).join('\n');
    return `\n\nOn ${when(msg.date, true)}, ${who(msg.from)} wrote:\n${text}`;
  }
  function compose(opts = {}) {
    const accounts = mailAccounts();
    if (!accounts.length) return connect();
    const msg = opts.msg || {};
    const fromKey = opts.from || (state.scope !== 'all' ? state.scope : accounts[0].key);
    const me = (accounts.find(a => a.key === fromKey) || accounts[0]).email;
    let to = [], cc = [], subject = '', body = '', replyTo = null, title = 'New message';
    const sourceOf = key => key.split(':')[0];
    if (opts.mode === 'reply' || opts.mode === 'all') {
      title = opts.mode === 'all' ? 'Reply all' : 'Reply';
      replyTo = msg.id;
      to = msg.from && msg.from.email ? [msg.from.email] : [];
      if (opts.mode === 'all') {
        cc = [...(msg.to || []), ...(msg.cc || [])].map(p => p.email).filter(e => e && e.toLowerCase() !== me && !to.includes(e));
      }
      subject = /^re:/i.test(msg.subject || '') ? msg.subject : `Re: ${msg.subject || ''}`.trim();
      // Outlook adds the quoted message to a reply itself; Gmail drafts carry what we write.
      if (sourceOf(fromKey) === 'google') body = quote(msg);
    } else if (opts.mode === 'forward') {
      title = 'Forward';
      subject = /^fwd?:/i.test(msg.subject || '') ? msg.subject : `Fwd: ${msg.subject || ''}`.trim();
      body = `\n\n---------- Forwarded message ----------\nFrom: ${who(msg.from)} <${(msg.from || {}).email || ''}>\nDate: ${when(msg.date, true)}\n` +
        `Subject: ${msg.subject || ''}\nTo: ${(msg.to || []).map(p => p.email).join(', ')}\n\n${msg.body_text || ''}`;
    } else if (opts.mode === 'draft') {
      title = 'Draft';
      to = (msg.to || []).map(p => p.email); cc = (msg.cc || []).map(p => p.email);
      subject = msg.subject || ''; body = msg.body_text || '';
    }
    const form = el('form', null, 'wm-compose', { autocomplete: 'off' });
    const field = (label, input) => { const w = el('label', null, 'wm-cfield'); w.append(el('span', label), input); return w; };
    let fromSel = null;
    if (accounts.length > 1) {
      fromSel = el('select', null, 'wz-field', { 'aria-label': 'From' });
      for (const a of accounts) { const o = el('option', a.email, null, { value: a.key }); if (a.key === fromKey) o.selected = true; fromSel.append(o); }
      if (replyTo) fromSel.disabled = true;
      form.append(field('From', fromSel));
    }
    const toIn = el('input', null, 'wz-field', { type: 'text', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'To' }); toIn.value = to.join(', ');
    const ccIn = el('input', null, 'wz-field', { type: 'text', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Cc' }); ccIn.value = cc.join(', ');
    const bccIn = el('input', null, 'wz-field', { type: 'text', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Bcc' });
    const subIn = el('input', null, 'wz-field', { type: 'text', maxlength: '300', 'aria-label': 'Subject' }); subIn.value = subject;
    const bodyIn = el('textarea', null, 'wz-field wm-cbody', { rows: '10', 'aria-label': 'Message' }); bodyIn.value = body;
    const ccRow = field('Cc', ccIn), bccRow = field('Bcc', bccIn);
    ccRow.hidden = !cc.length; bccRow.hidden = true;
    const toggles = el('div', null, 'wm-ctoggles');
    if (!cc.length) toggles.append(button('Cc', e => { ccRow.hidden = false; e.target.remove(); ccIn.focus(); }, 'wz-chip'));
    toggles.append(button('Bcc', e => { bccRow.hidden = false; e.target.remove(); bccIn.focus(); }, 'wz-chip'));
    form.append(field('To', toIn), ccRow, bccRow, toggles, field('Subject', subIn), bodyIn);
    if (opts.mode === 'forward' && msg.attachments && msg.attachments.length) form.append(el('p', 'Attachments are not forwarded yet.', 'muted'));
    const msgLine = el('p', '', 'wm-cmsg', { role: 'alert' });
    const send = el('button', 'Send', 'wz-button', { type: 'submit' });
    const save = button('Save draft', () => submit(false), 'wz-button secondary');
    const acts = el('div', null, 'wz-actions'); acts.append(save, send);
    form.append(msgLine, acts);
    let hold = null;
    const dirty = () => { if (!hold && window.WizardApp && window.WizardApp.update) { try { hold = window.WizardApp.update.hold('unsent mail'); } catch (_) {} } };
    form.addEventListener('input', dirty);
    const release = () => { if (hold) { try { hold.release(); } catch (_) {} hold = null; } };
    form.onsubmit = e => { e.preventDefault(); submit(true); };
    async function submit(andSend) {
      const t = parseAddresses(toIn.value), c = parseAddresses(ccIn.value), b = parseAddresses(bccIn.value);
      const bad = [...t.bad, ...c.bad, ...b.bad];
      if (bad.length) { msgLine.textContent = `Check this address: ${bad[0]}`; return; }
      if (!t.out.length && !replyTo) { msgLine.textContent = 'Add someone to send it to.'; toIn.focus(); return; }
      const account = fromSel ? fromSel.value : fromKey;
      send.disabled = save.disabled = true;
      msgLine.textContent = andSend ? 'Sending…' : 'Saving…';
      try {
        const draft = await api('api/draft', { account, to: t.out, cc: c.out, bcc: b.out, subject: subIn.value, body: bodyIn.value, reply_to_id: replyTo });
        if (andSend) await api('api/send', { account, draft_id: draft.draft.id });
        if (opts.mode === 'draft' && msg.id) api('api/update', { account: fromKey, id: msg.id, trashed: true }).catch(() => {});
        release();
        closeSheet();
        say(andSend ? 'Sent.' : 'Saved in Drafts.');
        if (state.folder === 'drafts' || state.folder === 'sent') load(true);
      } catch (err) {
        msgLine.textContent = err.message;
        send.disabled = save.disabled = false;
      }
    }
    openSheet(title, form);
    sheet.classList.add('wm-composer');
    sheet.addEventListener('close', function onClose() { sheet.removeEventListener('close', onClose); sheet.classList.remove('wm-composer'); release(); });
    (to.length ? bodyIn : toIn).focus();
    if (to.length) { bodyIn.setSelectionRange(0, 0); }
  }

  // ---------- wiring ----------
  document.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const name = act.dataset.act;
    if (name === 'write') compose();
    else if (name === 'add') connect();
    else if (name === 'settings') openSettings();
    else if (name === 'scope') scopeSheet();
    else if (name === 'refresh') { loadAccounts().then(ok => ok && load(true)).catch(err => say(err.message)); }
    else if (name === 'more') load(false);
  });
  $('.wm-search').addEventListener('submit', e => { e.preventDefault(); state.q = e.target.q.value.trim(); load(true); });
  $('.wm-search input').addEventListener('search', e => { if (!e.target.value && state.q) { state.q = ''; load(true); } });
  // New mail on return, at most every two minutes (each refresh costs Composio calls on Quick connect accounts).
  const maybeRefresh = () => { if (document.visibilityState === 'visible' && mailAccounts().length && Date.now() - state.lastLoad > 120_000 && !state.compose) load(true); };
  document.addEventListener('visibilitychange', maybeRefresh);
  addEventListener('focus', maybeRefresh);
  new ResizeObserver(() => root.classList.toggle('wm-narrow', narrow())).observe(root);

  loadAccounts().then(ok => { if (ok) load(true); }).catch(e => {
    listEl.replaceChildren(el('div', null, 'wz-empty'));
    listEl.firstChild.append(el('strong', 'Mail is not available'), el('p', e.message));
  });
})();
