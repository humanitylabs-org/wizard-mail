/* Wizard Mail: one inbox for the Google and Microsoft accounts on this Wizard.
 * Reads through this app's API (which asks the Google and Microsoft apps); connects new accounts with
 * WizardConnect (connect.js) without leaving the window. Mail is other people's text: it is shown, never run. */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const root = $('.wm');
  const listEl = $('.wm-list'), reader = $('.wm-reader'), toast = $('.wm-toast');
  const MARKABLE = new Set(['inbox', 'archive']);
  const UNREADABLE = new Set(['inbox']);
  const FOLDERS = [['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['archive', 'Archive'], ['trash', 'Trash']];
  const state = { accounts: null, scope: 'all', folder: 'inbox', q: '', unread: false, messages: [], cursor: null, open: null, view: 'list', loading: 0, lastLoad: 0, compose: null, shown: '', finding: false };
  // Fixed icons (constant markup, never mail text).
  const ICON = {
    reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8L4 13l6 5M4 13h10a6 6 0 0 1 6 6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v4H4zM5.5 9v10h13V9M10 13h4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M6.5 7l1 13h9l1-13"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2h4l1-2h5"/></svg>',
  };

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
  // Phone-sized window: thumb bars at the bottom and the newest mail at the bottom of the list.
  function phoneSize() { return root.clientWidth < 600; }
  function setView(v) { state.view = v; root.dataset.view = v; }
  // Compact list (Miguel's default): sender, subject, time and the unread dot; Settings brings previews back.
  // Kept on this device only.
  const PREVIEWS = 'wizard-mail.previews';
  function previewsOn() { try { return localStorage.getItem(PREVIEWS) === '1'; } catch (_) { return false; } }
  function setPreviews(on) {
    try { if (on) localStorage.setItem(PREVIEWS, '1'); else localStorage.removeItem(PREVIEWS); } catch (_) {}
    root.classList.toggle('wm-compact', !on);
    renderList();
  }
  root.classList.toggle('wm-compact', !previewsOn());

  // ---------- Back: reader -> list (phone); sheets and layers register their own ----------
  if (window.WizardApp && window.WizardApp.version === 1) {
    window.WizardApp.ready({ name: 'wizard-mail', version: '0.5.0' });
    window.WizardApp.back.register({
      // The reader opens beside the list (or over it on a phone); Back, Escape and ✕ close it and leave the list as it was.
      canGoBack: () => state.view === 'reader' || state.finding,
      back: () => {
        if (state.view === 'reader') { closeReader(); return true; }
        if (state.finding) { unfind(); return true; }
        return false;
      },
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
      accounts: () => state.accounts, say, previews: previewsOn, setPreviews,
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
    // Unread sits under Inbox: in the side list as Inbox's own sub-item, in the chip layout as a chip under the Inbox chip.
    folders.replaceChildren(...FOLDERS.flatMap(([id, label]) => {
      const on = state.folder === id && !(id === 'inbox' && state.unread);
      const b = button('', () => pickFolder(id, false), 'wm-navitem' + (on ? ' on' : ''), { 'data-folder': id });
      b.append(el('span', label, 'wm-grow'));
      if (id !== 'inbox') return [b];
      b.append(el('span', '', 'wm-count'));
      const sub = button('', () => pickFolder('inbox', true), 'wm-navitem wm-navsub' + (state.folder === 'inbox' && state.unread ? ' on' : ''));
      sub.append(el('span', 'Unread', 'wm-grow'), el('span', '', 'wm-count'));
      return [b, sub];
    }));
    $('.wm-folders').replaceChildren(...FOLDERS.map(([id, label]) => {
      const c = button(label, () => pickFolder(id), 'wz-chip wm-fchip', { role: 'tab', 'aria-selected': String(state.folder === id), 'data-folder': id });
      if (id === 'inbox') c.append(el('span', '', 'wm-count'));
      return c;
    }));
    if (!$('.wm-unreadf .wm-count')) $('.wm-unreadf').append(el('span', '', 'wm-count'));
    showCounts();
    $('.wm-scope').textContent = accountName(state.scope) + (accounts.length > 1 ? ' ▾' : '');
    // Mark all as read: for mail that arrives (Inbox, Archive); Sent, Drafts and Trash have nothing to review.
    $('.wm-markall').hidden = !accounts.length || !MARKABLE.has(state.folder);
    // Unread filter (Inbox only): stays on across accounts; leaving the Inbox turns it off.
    const uf = $('.wm-unreadf');
    $('.wm-filter').hidden = !UNREADABLE.has(state.folder);
    uf.setAttribute('aria-pressed', String(state.unread));
  }
  // Unread count on Inbox (chip and side item) and the Unread chip, from the same list the app badge counts
  // (newest 50 unread inbox mail; '50+' when there is more). Follows the account picked at the top.
  function unreadCount() {
    let n = 0;
    if (state.scope === 'all') n = unreadKeys.size;
    else { const pre = `msg:${state.scope}:`; for (const k of unreadKeys) if (k.startsWith(pre)) n++; }
    if (!n) return '';
    return unreadMore ? `${n}+` : String(n);
  }
  function showCounts() {
    const text = unreadCount();
    for (const c of document.querySelectorAll('.wm-count')) { c.textContent = text; c.hidden = !text; }
    const label = text ? `, ${text} unread` : '';
    for (const b of document.querySelectorAll('[data-folder="inbox"]')) b.setAttribute('aria-label', 'Inbox' + label);
    $('.wm-unreadf').setAttribute('aria-label', 'Unread' + (text ? `, ${text}` : ''));
  }
  function unreadOnly() { return state.unread && UNREADABLE.has(state.folder); }
  function toggleUnread() { state.unread = !state.unread; renderSide(); load(true); }
  function pickScope(key) { state.scope = key; closeSheet(); renderSide(); load(true); }
  function pickFolder(id, unread) { state.folder = id; if (unread !== undefined) state.unread = unread; else if (id !== 'inbox') state.unread = false; renderSide(); load(true); }
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
  function listKey() { return [state.scope, state.folder, state.q, unreadOnly() ? 'u' : ''].join('|'); }
  // load(true): first page. A refresh of the same list keeps the rows on screen (and, on a phone, the place he is
  // reading) until the new page arrives; a new folder/account/search starts at the newest mail.
  async function load(fresh, opts = {}) {
    if (!mailAccounts().length) return;
    const mine = ++state.loading;
    const same = fresh && state.shown === listKey() && state.messages.length && listEl.querySelector('.wm-item');
    let place = fresh ? 'keep' : 'older';
    if (fresh) {
      state.cursor = null;
      if (!same) { place = 'newest'; listEl.replaceChildren(el('div', 'Loading…', 'wm-loading')); }
      else if (opts.toNewest) place = 'newest';
    }
    const qs = new URLSearchParams({ account: state.scope, folder: state.folder });
    if (state.q) qs.set('q', state.q);
    if (unreadOnly()) qs.set('unread', '1');
    if (!fresh && state.cursor) qs.set('cursor', state.cursor);
    try {
      const v = await api('api/messages?' + qs);
      if (mine !== state.loading) return;
      state.messages = fresh ? v.messages : state.messages.concat(v.messages);
      state.cursor = v.cursor;
      state.lastLoad = Date.now();
      state.shown = listKey();
      renderList(place);
      if (v.errors && v.errors.length) say(`${v.errors[0].email}: ${v.errors[0].message}`);
    } catch (e) {
      if (mine !== state.loading) return;
      listEl.replaceChildren(el('div', null, 'wz-empty'));
      listEl.firstChild.append(el('strong', 'Mail did not load'), el('p', e.message), button('Try again', () => load(true), 'wz-button secondary'));
    }
  }
  // Phone (narrow window): newest at the bottom, like a chat; opens at the newest, Load more sits on top, and new
  // mail never moves what he is reading while scrolled up. Wide windows stay newest-first from the top.
  let stick = true, phoneOrder = null;
  function nearEnd() { return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 8; }
  listEl.addEventListener('scroll', () => { if (phoneOrder) stick = nearEnd(); }, { passive: true });
  function toNewest() { if (phoneOrder) { listEl.scrollTop = listEl.scrollHeight; stick = true; } else listEl.scrollTop = 0; }
  function anchorRow() {
    // the lowest row he can see, and where it sits, so a re-render can put it back
    const box = listEl.getBoundingClientRect();
    let best = null;
    for (const n of listEl.querySelectorAll('.wm-item')) {
      const r = n.getBoundingClientRect();
      if (r.top < box.bottom && r.bottom > box.top) best = { id: n.dataset.id, off: r.top - box.top };
    }
    return best;
  }
  function renderList(place = 'keep') {
    const phone = phoneSize();
    const flipped = phoneOrder !== null && phoneOrder !== phone;
    const anchor = phone && phoneOrder && ((!stick && place === 'keep') || place === 'older') ? anchorRow() : null;
    phoneOrder = phone;
    $('.wm-more').hidden = phone || !state.cursor;
    if (!state.messages.length) {
      const empty = el('div', null, 'wz-empty');
      if (unreadOnly() && !state.q) empty.append(el('strong', 'No unread mail'), el('p', 'You have read everything here.'));
      else empty.append(el('strong', state.q ? 'Nothing matches' : 'Nothing here'), el('p', state.q ? 'Try other words.' : 'New mail shows up here.'));
      listEl.replaceChildren(empty);
      return;
    }
    const many = mailAccounts().length > 1 && state.scope === 'all';
    const rows = state.messages.map(m => item(m, many));
    if (!phone) {
      listEl.replaceChildren(...rows);
      if (place === 'newest' || flipped) listEl.scrollTop = 0;
      return;
    }
    rows.reverse();
    if (state.cursor) rows.unshift(button('Load more', () => load(false), 'wz-button secondary wm-more wm-more-top'));
    listEl.replaceChildren(...rows);
    if (anchor) {
      const n = listEl.querySelector(`.wm-item[data-id="${CSS.escape(anchor.id)}"]`);
      if (n) { listEl.scrollTop += (n.getBoundingClientRect().top - listEl.getBoundingClientRect().top) - anchor.off; stick = nearEnd(); return; }
    }
    if (place === 'older') return;
    if (place === 'newest' || stick || flipped) toNewest();
  }
  // Keep the newest mail in view on a phone when the list's height changes (bars, keyboard, window size).
  new ResizeObserver(() => { if (phoneOrder && stick) listEl.scrollTop = listEl.scrollHeight; }).observe(listEl);
  function item(m, many) {
    const sent = state.folder === 'sent' || state.folder === 'drafts';
    const name = sent ? (m.to && m.to.length ? 'To ' + m.to.map(who).join(', ') : '(no recipient)') : (who(m.from) || '(unknown sender)');
    const b = el('button', null, 'wm-item' + (m.unread ? ' unread' : '') + (state.open && state.open.id === m.id ? ' on' : ''), { type: 'button', role: 'listitem' });
    b.dataset.id = m.id;
    b.onclick = () => openMessage(m);
    const top = el('span', null, 'wm-line');
    top.append(el('b', name, 'wm-from'), el('time', when(m.date), 'wm-when', { datetime: m.date || '' }));
    const subj = el('span', m.subject || '(no subject)', 'wm-subj');
    const main = el('span', null, 'wm-itemmain');
    main.append(top, subj);
    if (previewsOn()) {
      b.append(el('span', initial(name.replace(/^To /, '')), 'wz-tile wm-avatar', { 'aria-hidden': 'true' }));
      main.append(el('span', m.snippet || '', 'wm-snip'));
      if (many) main.append(el('span', m.account_email, 'wm-acct'));
    } else if (many) b.title = m.account_email || '';
    b.append(main);
    if (m.unread) b.append(el('span', '', 'wm-unread', { 'aria-label': 'Unread' }));
    return b;
  }

  // ---------- reader ----------
  let frameObserver = null;
  function markOpen() {
    for (const n of listEl.querySelectorAll('.wm-item')) n.classList.toggle('on', !!(state.open && n.dataset.id === state.open.id));
  }
  function closeReader() {
    const was = state.open && listEl.querySelector('.wm-item.on');
    state.open = null;
    if (frameObserver) { frameObserver.disconnect(); frameObserver = null; }
    setView('list');
    markOpen();
    // Empty the pane after it has slid away (phone) so the list underneath never jumps.
    setTimeout(() => { if (state.view === 'list') reader.replaceChildren(); }, 260);
    if (was) try { was.focus({ preventScroll: true }); } catch (_) {}
  }
  async function openMessage(m, images) {
    state.open = { id: m.id, account: m.account, summary: m };
    markOpen();
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
      const row = listEl.querySelector(`.wm-item[data-id="${CSS.escape(m.id)}"]`);
      if (row) { row.classList.remove('unread'); const dot = row.querySelector('.wm-unread'); if (dot) dot.remove(); }
      api('api/update', { account: m.account, id: m.id, read: true }).then(() => readOne(m)).catch(() => {});
    }
  }
  function renderReader(m, v) {
    const msg = v.message;
    const bar = el('div', null, 'wm-rbar');
    bar.append(button('‹ Back', closeReader, 'wm-icon wm-back', { 'aria-label': 'Back to the list' }));
    bar.append(el('span', null, 'wm-grow'));
    const x = button('', closeReader, 'wm-icon wm-close', { 'aria-label': 'Close', title: 'Close (Esc)' });
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    // Phone: Reply, Archive and Delete also sit in a bottom bar under his thumb; the copies above hide there.
    const thumb = el('div', null, 'wm-rbb');
    const cell = (label, icon, fn) => { const c = button('', fn, 'wm-bcell'); c.innerHTML = icon; c.append(el('span', label)); thumb.append(c); };
    if (state.folder === 'drafts') {
      const edit = () => compose({ mode: 'draft', from: m.account, msg });
      bar.append(button('Edit and send', edit, 'wz-button wm-dup'));
      cell('Edit and send', ICON.edit, edit);
    } else {
      const reply = () => compose({ mode: 'reply', from: m.account, msg });
      bar.append(button('Reply', reply, 'wz-button wm-dup'),
        button('Reply all', () => compose({ mode: 'all', from: m.account, msg }), 'wz-button secondary'),
        button('Forward', () => compose({ mode: 'forward', from: m.account, msg }), 'wz-button secondary'));
      cell('Reply', ICON.reply, reply);
    }
    const more = el('div', null, 'wm-ractions');
    if (canArchive()) {
      const archive = () => archiveIt(m);
      more.append(button('Archive', archive, 'wz-chip wm-dup'));
      cell('Archive', ICON.archive, archive);
    }
    if (state.folder === 'trash') {
      const back = () => change(m, { trashed: false }, 'Moved to Inbox', { trashed: true });
      more.append(button('Move to Inbox', back, 'wz-chip wm-dup'));
      cell('To Inbox', ICON.inbox, back);
    } else {
      const del = () => change(m, { trashed: true }, 'Moved to Trash', { trashed: false });
      more.append(button('Delete', del, 'wz-chip wm-dup'));
      cell('Delete', ICON.trash, del);
    }
    if (state.folder !== 'drafts') more.append(button('Mark unread', () => markUnread(m), 'wz-chip'));
    // Reply in chat: this email as context in an unsent Chats draft to the owner's agent. Named apart from the
    // email Reply above. In this row so it shows at every width without crowding the phone bar; shown only on
    // shells that have the shared draft (older Wizards just don't show it).
    if (v.context && typeof window.WizardApp?.nav?.openContextDraft === 'function') {
      more.append(button('Reply in chat', () => replyInChat(v.context), 'wz-chip wm-chat'));
    }
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
    bar.append(x);
    reader.replaceChildren(bar, head, body, thumb);
    reader.scrollTop = 0;
  }
  // Synchronous inside the tap (user activation): the context came with the message, nothing is fetched here.
  function replyInChat(ctx) {
    try {
      const receipt = window.WizardApp.nav.openContextDraft(ctx);
      if (!receipt || receipt.kind !== 'unsent-draft' || receipt.sent !== false) throw new Error('Could not confirm an unsent draft. Nothing was sent.');
      say('Draft opened in Chats with this email attached. Nothing sent.');
    } catch (e) {
      say(e && e.message === 'Context draft unavailable' ? 'Reload Wizard (refresh the whole page) to turn on Reply in chat. Nothing sent.'
        : (e && e.message) || 'Could not open Chats. Nothing sent.');
    }
  }
  function htmlFrame(html, images) {
    // No scripts, no forms, no top navigation; same-origin only so this page can size the frame to its content.
    const csp = `default-src 'none'; img-src data:${images ? ' https:' : ''}; style-src 'unsafe-inline'; font-src data:`;
    const frame = el('iframe', null, 'wm-frame', { title: 'Message', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
      '<meta name="referrer" content="no-referrer"><base target="_blank"><style>html{color-scheme:light}body{margin:0;padding:18px 20px;background:Canvas;color:CanvasText;' +
      'font:0.9375rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%!important}' +
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
    if (state.open && state.open.id === m.id) closeReader();
    try {
      const out = await api('api/update', { account: m.account, id: m.id, ...flags });
      const id = out.id || m.id;
      readOne(m);
      say(done, async () => {
        try {
          await api('api/update', { account: m.account, id, ...undoFlags });
          state.messages.splice(Math.max(0, at), 0, { ...m, id });
          renderList();
          refreshBadge(true);
        } catch (e) { say(e.message); }
      });
    } catch (e) {
      state.messages.splice(Math.max(0, at), 0, m);
      renderList();
      say(e.message);
    }
  }
  function canArchive() { return !['archive', 'trash', 'drafts', 'sent'].includes(state.folder); }
  function archiveIt(m) { return change(m, { archived: true }, 'Archived', { archived: false }); }
  async function markUnread(m) {
    m.unread = true;
    renderList();
    closeReader();
    unreadLocal(m, true);
    try { await api('api/update', { account: m.account, id: m.id, read: false }); say('Marked unread'); refreshBadge(true); }
    catch (e) { say(e.message); }
  }
  // Swipe right on a row: read <-> unread, with Undo.
  async function toggleRead(m, undoing) {
    const read = m.unread;
    const set = unread => {
      m.unread = unread;
      const row = listEl.querySelector(`.wm-item[data-id="${CSS.escape(m.id)}"]`);
      if (row) row.replaceWith(item(m, mailAccounts().length > 1 && state.scope === 'all'));
      unreadLocal(m, unread);
    };
    set(!read);
    try {
      await api('api/update', { account: m.account, id: m.id, read });
      if (!undoing) say(read ? 'Marked read' : 'Marked unread', () => toggleRead(m, true));
      refreshBadge(true);
    } catch (e) { set(read); say(e.message); }
  }

  // Mark all as read (top centre): every unread message in what the list shows (account scope, folder, search) is
  // marked read at Gmail / Outlook, not only the loaded rows. One tap, no question; Undo in the toast.
  let marking = false;
  async function markAll() {
    if (marking) return;
    const btn = $('.wm-markall');
    const scope = { account: state.scope, folder: state.folder, q: state.q };
    const before = state.messages.filter(m => m.unread);
    marking = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Marking…';
    for (const m of before) { m.unread = false; unreadLocal(m, false); }
    renderList();
    try {
      const v = await api('api/mark-all-read', scope);
      const n = v.count || 0;
      const left = (v.failed || []).length;
      const changed = v.changed || [];
      if (!n && !left) say('Nothing unread here.');
      else {
        let text = n === 1 ? 'Marked 1 as read' : `Marked ${n} as read`;
        if (left) text += ` · ${left} did not change`;
        if (v.more) text += ' · tap again for the rest';
        say(text, changed.length ? () => undoMarkAll(changed) : null);
      }
      if (v.errors && v.errors.length) setTimeout(() => say(v.errors[0].message), 6200);
      refreshBadge(true);
    } catch (e) {
      for (const m of before) m.unread = true;
      renderList();
      say(e.message);
    } finally {
      marking = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Mark all as read';
    }
  }
  async function undoMarkAll(changed) {
    try {
      await api('api/mark-read', { items: changed, read: false });
      const keys = new Set(changed.map(c => `${c.account}|${c.id}`));
      for (const m of state.messages) if (keys.has(`${m.account}|${m.id}`)) m.unread = true;
      renderList();
      say(changed.length === 1 ? '1 is unread again' : `${changed.length} are unread again`);
      refreshBadge(true);
    } catch (e) { say(e.message); }
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
  const MAX_FILES = 10, MAX_BYTES = 18 * 1048576;  // what the Google/Microsoft apps take on one draft
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
    // Attachments: the draft's own files (Draft edit) or the original's (Forward) come along as chips; Attach adds more.
    // Kept files stay at the source (draft_id / attachments_from); only new files travel as base64.
    const files = [];
    const keptFrom = opts.mode === 'draft' ? 'draft' : opts.mode === 'forward' ? 'forward' : null;
    if (keptFrom) for (const a of msg.attachments || []) if (a && a.name) files.push({ name: a.name, size: a.size || 0, kept: true });
    if (fromSel && (files.length || (opts.mode === 'draft' && msg.draft_id))) fromSel.disabled = true;  // kept files and the draft live in this account
    const picker = el('input', null, null, { type: 'file', multiple: '', hidden: '', 'aria-hidden': 'true', tabindex: '-1' });
    const attachBtn = button('Attach', () => picker.click(), 'wz-chip wm-attach', { 'aria-label': 'Attach files' });
    attachBtn.prepend(el('span', '📎', null, { 'aria-hidden': 'true' }));
    const chips = el('ul', null, 'wm-cfiles', { 'aria-label': 'Attachments' });
    const outlookNote = el('p', 'Outlook accounts take files up to 3 MB each.', 'wm-cnote');
    const attachRow = el('div', null, 'wm-cattach');
    attachRow.append(attachBtn, picker, chips);
    const accountNow = () => (fromSel ? fromSel.value : fromKey);
    const showNote = () => { outlookNote.hidden = sourceOf(accountNow()) !== 'microsoft'; };
    if (fromSel) fromSel.addEventListener('change', showNote);
    showNote();
    function drawFiles() {
      chips.replaceChildren(...files.map(f => {
        const li = el('li', null, 'wz-chip wm-cfile' + (f.reading ? ' wm-reading' : ''));
        li.append(el('span', f.name, 'wm-cfname'), el('small', f.reading ? 'Reading…' : size(f.size)));
        li.append(button('✕', () => { files.splice(files.indexOf(f), 1); dirty(); drawFiles(); }, 'wm-cfx', { 'aria-label': `Remove ${f.name}` }));
        return li;
      }));
    }
    function size(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`; }
    function addFiles(list) {
      const picked = Array.from(list || []);
      if (!picked.length) return;
      msgLine.textContent = '';
      const microsoft = sourceOf(accountNow()) === 'microsoft';
      for (const file of picked) {
        const total = files.reduce((n, f) => n + (f.size || 0), 0);
        if (files.length >= MAX_FILES) { msgLine.textContent = `At most ${MAX_FILES} attachments on one email.`; break; }
        if (microsoft && file.size > 3 * 1048576) { msgLine.textContent = `${file.name} is over 3 MB: Outlook accounts take files up to 3 MB each for now.`; continue; }
        if (total + file.size > MAX_BYTES) { msgLine.textContent = `${file.name} doesn't fit: attachments can be 18 MB together.`; continue; }
        const f = { name: file.name || 'file', mime: file.type || '', size: file.size, reading: true };
        files.push(f);
        f.ready = new Promise(done => {
          const r = new FileReader();
          r.onload = () => { const url = String(r.result || ''); f.base64 = url.slice(url.indexOf(',') + 1); f.reading = false; drawFiles(); done(); };
          r.onerror = () => { files.splice(files.indexOf(f), 1); msgLine.textContent = `${f.name} could not be read. Try again.`; drawFiles(); done(); };
          r.readAsDataURL(file);
        });
      }
      dirty();
      drawFiles();
    }
    picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });
    form.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
    form.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    drawFiles();
    form.append(attachRow, outlookNote);
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
      send.disabled = save.disabled = attachBtn.disabled = true;
      const fresh = files.filter(f => !f.kept);
      msgLine.textContent = (andSend ? 'Sending…' : 'Saving…') + (fresh.length ? ` (${fresh.length === 1 ? '1 file' : fresh.length + ' files'})` : '');
      try {
        await Promise.all(fresh.map(f => f.ready));
        const payload = { account, to: t.out, cc: c.out, bcc: b.out, subject: subIn.value, body: bodyIn.value, reply_to_id: replyTo };
        const live = files.filter(f => !f.kept && f.base64 != null);
        if (live.length) payload.attachments = live.map(f => ({ name: f.name, mime: f.mime || undefined, base64: f.base64 }));
        const keptNames = new Set(files.filter(f => f.kept).map(f => f.name));
        const dropped = (msg.attachments || []).map(a => a && a.name).filter(n => n && !keptNames.has(n));
        // Draft edit: change the same draft in place (its files stay at the source). An older source without draft ids:
        // save a new draft that copies the old one's files, then trash the old one.
        const inPlace = opts.mode === 'draft' && msg.draft_id && account === fromKey;
        if (inPlace) { payload.draft_id = msg.draft_id; if (!b.out.length) delete payload.bcc; }  // Bcc isn't shown on a draft: keep the old one
        else if (keptFrom && keptNames.size && account === fromKey) payload.attachments_from = msg.id;
        if ((inPlace || payload.attachments_from) && dropped.length) payload.remove_attachments = dropped;
        const draft = await api('api/draft', payload);
        if (andSend) await api('api/send', { account, draft_id: draft.draft.id });
        if (opts.mode === 'draft' && msg.id && !inPlace) api('api/update', { account: fromKey, id: msg.id, trashed: true }).catch(() => {});
        release();
        closeSheet();
        say(andSend ? 'Sent.' : 'Saved in Drafts.');
        if (state.folder === 'drafts' || state.folder === 'sent') load(true);
      } catch (err) {
        msgLine.textContent = err.message;
        send.disabled = save.disabled = attachBtn.disabled = false;
      }
    }
    openSheet(title, form);
    sheet.classList.add('wm-composer');
    sheet.addEventListener('close', function onClose() { sheet.removeEventListener('close', onClose); sheet.classList.remove('wm-composer'); release(); });
    (to.length ? bodyIn : toIn).focus();
    if (to.length) { bodyIn.setSelectionRange(0, 0); }
  }

  // ---------- touch: swipe a row, pull the list down ----------
  // Swipe left = Archive (where Archive exists), swipe right = read/unread; both offer Undo. Reader buttons stay the
  // visible way to do the same. Touch only: a mouse keeps plain clicks and text selection.
  const SWIPE_AT = 72;
  let swipe = null, swallowClick = false;
  listEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const row = e.target.closest('.wm-item');
    if (!row) return;
    swipe = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, on: false, pid: e.pointerId };
  });
  listEl.addEventListener('pointermove', e => {
    if (!swipe || e.pointerId !== swipe.pid) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
      if (Math.abs(dx) < 12) return;
      swipe.on = true;
      try { swipe.row.setPointerCapture(e.pointerId); } catch (_) {}
    }
    const m = state.messages.find(x => x.id === swipe.id);
    if (!m) return;
    let d = dx;
    if (d < 0 && !canArchive()) d = 0;
    if (d > 0 && state.folder === 'drafts') d = 0;
    swipe.dx = d;
    const row = swipe.row;
    row.classList.add('wm-swiping');
    row.style.transform = `translateX(${d}px)`;
    row.dataset.swipe = d < 0 ? 'archive' : d > 0 ? (m.unread ? 'read' : 'unread') : '';
    row.dataset.swipeLabel = d < 0 ? 'Archive' : m.unread ? 'Read' : 'Unread';
    row.classList.toggle('wm-armed', Math.abs(d) >= SWIPE_AT);
  });
  const endSwipe = cancel => {
    if (!swipe) return;
    const { row, id, dx, on } = swipe;
    swipe = null;
    if (!on) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 350);
    row.classList.remove('wm-swiping', 'wm-armed');
    row.style.transform = '';
    delete row.dataset.swipe;
    const m = state.messages.find(x => x.id === id);
    if (cancel || !m || Math.abs(dx) < SWIPE_AT) return;
    if (dx < 0) archiveIt(m); else toggleRead(m);
  };
  listEl.addEventListener('pointerup', () => endSwipe(false));
  listEl.addEventListener('pointercancel', () => endSwipe(true));
  listEl.addEventListener('click', e => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; } }, true);

  // Pull the list down from its top to refresh (touch).
  const pull = $('.wm-pull');
  const PULL_AT = 64;
  let pullY = null, pulled = 0;
  listEl.addEventListener('touchstart', e => { pullY = listEl.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; pulled = 0; }, { passive: true });
  listEl.addEventListener('touchmove', e => {
    if (pullY === null || swipe && swipe.on) return;
    const d = e.touches[0].clientY - pullY;
    if (d <= 0 || listEl.scrollTop > 0) { pulled = 0; pull.style.height = ''; return; }
    pulled = Math.min(96, d * 0.5);
    pull.style.height = pulled + 'px';
    pull.classList.toggle('wm-armed', pulled >= PULL_AT);
    pull.style.setProperty('--turn', `${Math.round(pulled * 4)}deg`);
  }, { passive: true });
  listEl.addEventListener('touchend', () => {
    if (pullY === null) return;
    pullY = null;
    if (pulled >= PULL_AT) refresh(true);
    pulled = 0;
    pull.style.height = '';
    pull.classList.remove('wm-armed');
  });

  function refresh(touch) {
    const btns = document.querySelectorAll('[data-act="refresh"]');
    btns.forEach(b => b.setAttribute('aria-busy', 'true'));
    if (touch) pull.classList.add('wm-busy');
    return loadAccounts().then(ok => ok && load(true, { toNewest: true })).catch(err => say(err.message))
      .finally(() => { btns.forEach(b => b.removeAttribute('aria-busy')); pull.classList.remove('wm-busy'); });
  }

  // Phone search: the bottom bar turns into the search field; ✕ or Back closes it and shows all mail again.
  const bbar = $('.wm-bbar'), bsearch = $('.wm-bsearch');
  function find() {
    state.finding = true;
    bbar.classList.add('wm-finding');
    bsearch.hidden = false;
    bsearch.q.value = state.q;
    bsearch.q.focus();
  }
  function unfind() {
    state.finding = false;
    bbar.classList.remove('wm-finding');
    bsearch.hidden = true;
    bsearch.q.blur();
    $('.wm-search input').value = '';
    if (state.q) { state.q = ''; load(true); }
  }
  bsearch.addEventListener('submit', e => { e.preventDefault(); state.q = bsearch.q.value.trim(); $('.wm-search input').value = state.q; bsearch.q.blur(); load(true); });
  bsearch.q.addEventListener('search', () => { if (!bsearch.q.value && state.q) { state.q = ''; load(true); } });

  // ---------- wiring ----------
  document.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const name = act.dataset.act;
    if (name === 'write') compose();
    else if (name === 'add') connect();
    else if (name === 'settings') openSettings();
    else if (name === 'scope') scopeSheet();
    else if (name === 'refresh') refresh(false);
    else if (name === 'find') find();
    else if (name === 'unfind') unfind();
    else if (name === 'more') load(false);
    else if (name === 'markall') markAll();
    else if (name === 'unread') toggleUnread();
  });
  $('.wm-search').addEventListener('submit', e => { e.preventDefault(); state.q = e.target.q.value.trim(); bsearch.q.value = state.q; load(true); });
  $('.wm-search input').addEventListener('search', e => { if (!e.target.value && state.q) { state.q = ''; load(true); } });
  // New mail on return, at most every two minutes (each refresh costs Composio calls on Quick connect accounts).
  const maybeRefresh = () => { if (document.visibilityState === 'visible' && mailAccounts().length && Date.now() - state.lastLoad > 120_000 && !state.compose) load(true); };
  document.addEventListener('visibilitychange', maybeRefresh);
  addEventListener('focus', maybeRefresh);
  new ResizeObserver(() => {
    root.classList.toggle('wm-narrow', narrow());
    // crossing between phone and wide flips the list order
    if (phoneOrder !== null && phoneOrder !== phoneSize() && state.messages.length) renderList();
    if (!phoneSize() && state.finding) { state.finding = false; bbar.classList.remove('wm-finding'); bsearch.hidden = true; }
  }).observe(root);

  // ---------- badge and Wizard inbox links ----------
  // The badge counts the unread inbox mail the Wizard inbox feed lists (api/inbox, newest 50), so the icon and
  // Chats always show the same number. Items open here as #msg=<account>:<id>.
  // `more`: unread mail beyond the newest 50, so the badge reads "50+" instead of looking exact.
  let unreadKeys = new Set(), badgeAt = 0, unreadMore = false;
  async function refreshBadge(force) {
    if (!force && Date.now() - badgeAt < 60_000) return;
    badgeAt = Date.now();
    try {
      const r = await fetch('api/inbox', { credentials: 'same-origin', cache: 'no-store' });
      const v = r.ok ? await r.json() : null;
      if (!v || !Array.isArray(v.items)) return;
      unreadKeys = new Set(v.items.map(i => i.key)); unreadMore = v.more === true;
      if (window.WizardApp && WizardApp.badge) WizardApp.badge.set(v.items.length, { more: unreadMore });
      showCounts();
    } catch (_) {}
  }
  function readOne(m) { unreadLocal(m, false); }
  // Change the counted list at once (the next badge refresh confirms it from the server).
  function unreadLocal(m, unread) {
    const key = `msg:${m.account}:${m.id}`;
    const had = unreadKeys.has(key);
    if (unread && !had && state.folder === 'inbox') unreadKeys.add(key);
    else if (!unread && had) unreadKeys.delete(key);
    else return;
    if (window.WizardApp && WizardApp.badge) WizardApp.badge.set(unreadKeys.size, { more: unreadMore });
    showCounts();
  }
  function openFromLink() {
    const hit = /^#msg=([^:]+):(.+)$/.exec(location.hash || '');
    if (!hit) return;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) {}
    const account = decodeURIComponent(hit[1]), id = decodeURIComponent(hit[2]);
    const known = state.messages.find(x => x.id === id && x.account === account);
    openMessage(known || { id, account, unread: true });
  }
  addEventListener('hashchange', () => { if (mailAccounts().length) openFromLink(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshBadge(); });

  loadAccounts().then(ok => { if (!ok) return; load(true); openFromLink(); refreshBadge(true); }).catch(e => {
    listEl.replaceChildren(el('div', null, 'wz-empty'));
    listEl.firstChild.append(el('strong', 'Mail is not available'), el('p', e.message));
  });
})();
