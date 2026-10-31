/* Mail Settings, modelled on Wizard Messenger's Settings (Miguel): "Connected accounts" as flat brand tiles with a
 * green dot, a + tile that opens the in-app Quick connect sheet (connect.js), and "Agent access": one row with the
 * same picker as Messenger (No access / Read-only / Draft only (recommended)).
 *
 * The level is kept and enforced by the source apps (wizard-google, wizard-microsoft: agent_access.py), so it holds
 * even when an agent calls their tools directly. This screen reads and writes it through their owner routes on this
 * same origin (`/wizard-google/api/mail-settings`, `api/agent-access`), which need the owner's Wizard session: no
 * agent or bearer path can change it. Classes are prefixed `wst-` (host apps' generic classes leak in). */
(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  // Brand marks (official four-colour Google G and Microsoft squares), drawn without a background, like Messenger.
  const MARKS = {
    google: { box: '0 0 48 48', paths: [
      ['rgb(234 67 53)', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
      ['rgb(66 133 244)', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
      ['rgb(251 188 5)', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
      ['rgb(52 168 83)', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z']] },
    microsoft: { box: '0 0 23 23', paths: [
      ['rgb(242 80 34)', 'M1 1h10v10H1z'], ['rgb(127 186 0)', 'M12 1h10v10H12z'],
      ['rgb(0 164 239)', 'M1 12h10v10H1z'], ['rgb(255 185 0)', 'M12 12h10v10H12z']] },
  };
  const NAMES = { google: 'Google', microsoft: 'Microsoft' };
  const VIA = { composio: 'Quick connect', 'own-client': 'Your own Google app', 'own-app': 'Your own Microsoft app' };
  const LEVEL_TEXT = { no_access: 'Agents can\'t read your mail.', read_only: 'Agents read and search your mail. They can\'t draft or send.',
    draft_only: 'Agents read, sort and write drafts. Only you send, from Mail.' };
  const RANK = { no_access: 0, read_only: 1, draft_only: 2 };

  function el(tag, text, cls, attrs) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    return n;
  }
  function button(text, fn, cls, attrs) { const b = el('button', text, cls, { type: 'button', ...attrs }); b.onclick = fn; return b; }
  function mark(source) {
    const m = MARKS[source];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', m ? m.box : '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'wst-mark');
    for (const [fill, d] of (m ? m.paths : [])) { const p = document.createElementNS(NS, 'path'); p.setAttribute('fill', fill); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }

  let dialog = null, opts = {}, data = null, say = () => {};
  const Sheet = () => window.WzSheet || { open: d => { if (!d.open) d.showModal(); }, close: d => d.close() };
  const client = id => window.WizardConnect.client(id);

  function frame(title, ...children) {
    if (!dialog) {
      dialog = el('dialog', null, 'wz-sheet wst-sheet', { 'aria-labelledby': 'wst-title' });
      document.body.append(dialog);
    }
    // Keep the kit's grip and × (WzSheet adds them once) when the page inside changes.
    const keep = [...dialog.querySelectorAll(':scope > .wz-sheet-grip, :scope > .wz-sheet-x')];
    dialog.replaceChildren(...keep, el('h2', title, null, { id: 'wst-title' }), ...children);
    Sheet().open(dialog);
    return dialog;
  }
  function close() { if (dialog && dialog.open) Sheet().close(dialog); }

  // ---------- data: Mail's accounts plus each source app's owner view (ids, how to disconnect, agent level) ----------
  async function load() {
    const accounts = opts.accounts();
    const sources = (accounts && accounts.sources) || [];
    const views = await Promise.all(sources.map(async s => {
      if (!s.available) return { id: s.id, available: false, accounts: [], access: null };
      try {
        const v = await client(s.id).api('api/mail-settings');
        return { id: s.id, available: true, accounts: v.accounts || [], access: v.agent_access || null };
      } catch (e) {
        // An older source app: show what Mail knows; managing and agent access need the newer app.
        return { id: s.id, available: true, old: true, error: e.message,
          accounts: s.accounts.map(a => ({ email: a.email, label: a.label, status: a.status, via: a.via, services: [] })), access: null };
      }
    }));
    data = { sources: views };
    return data;
  }

  // ---------- main page ----------
  async function open(options) {
    opts = options; say = options.say || say;
    frame('Settings', el('p', 'Loading…', 'wst-muted'));
    try { await load(); } catch (e) { frame('Settings', el('p', e.message, 'wst-bad')); return; }
    render();
  }
  function render() {
    const tiles = el('div', null, 'wst-tiles', { role: 'list' });
    for (const s of data.sources) for (const a of s.accounts) tiles.append(tile(s, a));
    const plus = button('', () => { close(); opts.connect(); }, 'wst-tile wst-plus', { 'aria-label': 'Connect another account', role: 'listitem' });
    plus.append(el('span', null, 'wst-plus-mark', { 'aria-hidden': 'true' }), el('span', 'Add', 'wst-name'));
    tiles.append(plus);
    const parts = [el('h3', 'Connected accounts', 'wst-h'), tiles];
    if (!data.sources.some(s => s.accounts.length)) parts.push(el('p', 'Connect Google or Microsoft to see your mail here.', 'wst-muted'));
    parts.push(...agentAccess());
    if (opts.setPreviews) parts.push(...listOptions());
    frame('Settings', ...parts);
  }
  function tile(s, a) {
    const ok = a.status === 'active';
    const [user, domain] = String(a.email || '').split('@');
    const b = button('', () => manage(s, a), 'wst-tile' + (ok ? ' wst-on' : ' wst-warn'),
      { role: 'listitem', title: a.email, 'aria-label': `${a.email}, ${NAMES[s.id]}${ok ? '' : ', needs a new sign-in'}` });
    const icon = el('span', null, 'wst-icon');
    icon.append(mark(s.id), el('span', null, 'wst-dot', { 'aria-hidden': 'true' }));
    b.append(icon, el('span', a.label || user || NAMES[s.id], 'wst-name'), el('span', domain ? '@' + domain : '', 'wst-sub'));
    return b;
  }

  // ---------- the list: message previews are off by default (compact), remembered on this device ----------
  function listOptions() {
    const group = el('div', null, 'wst-group');
    const row = el('label', null, 'wst-row wst-switch-row');
    const sw = el('input', null, 'wst-switch', { type: 'checkbox', role: 'switch' });
    sw.checked = !!opts.previews();
    sw.onchange = () => opts.setPreviews(sw.checked);
    row.append(el('span', 'Message previews in the list', 'wst-agent'), sw);
    group.append(row);
    return [el('h3', 'Mail list', 'wst-h'), group];
  }
  // ---------- agent access: one row, Messenger's picker ----------
  function agentAccess() {
    const known = data.sources.filter(s => s.access);
    const old = data.sources.filter(s => s.available && !s.access && s.accounts.length);
    const out = [el('h3', 'Agent access', 'wst-h')];
    if (!known.length) {
      out.push(el('p', old.length ? `Update the ${old.map(s => NAMES[s.id]).join(' and ')} app to choose what agents may do.`
        : 'Connect an account first.', 'wst-muted'));
      return out;
    }
    // One level for every source; if they ever differ, show the stricter one (choosing sets both).
    const level = known.map(s => s.access.mail).sort((x, y) => RANK[x] - RANK[y])[0];
    const levels = known[0].access.levels;
    const group = el('div', null, 'wst-group');
    const row = el('div', null, 'wst-row');
    const choice = el('select', null, 'wst-level', { 'aria-label': 'What your agents may do with mail' });
    for (const l of levels) {
      const o = el('option', l.label + (l.recommended ? ' (recommended)' : ''), null, { value: l.id, title: LEVEL_TEXT[l.id] || l.what });
      choice.append(o);
    }
    choice.value = level;
    const note = el('p', LEVEL_TEXT[level] || '', 'wst-note');
    choice.onchange = async () => {
      const want = choice.value;
      choice.disabled = true;
      try {
        for (const s of known) s.access = (await client(s.id).api('api/agent-access', { mail: want })).agent_access;
        note.textContent = LEVEL_TEXT[want] || '';
        say(`Agent access: ${levels.find(l => l.id === want).label}`);
      } catch (e) {
        choice.value = level;
        say(e.message);
      } finally { choice.disabled = false; }
    };
    row.append(el('strong', 'Agents', 'wst-agent'), choice);
    group.append(row);
    out.push(group, note);
    if (known.some(s => s.access.mail !== level)) out.push(el('p', 'Google and Microsoft were set differently; choosing sets both.', 'wst-muted'));
    return out;
  }

  // ---------- one account: what it is, and Disconnect (two taps, inside the sheet) ----------
  function manage(s, a) {
    const ok = a.status === 'active';
    const facts = el('div', null, 'wst-group');
    const fact = (k, v) => { const r = el('div', null, 'wst-row wst-fact'); r.append(el('span', k, 'wst-k'), el('span', v, 'wst-v')); return r; };
    facts.append(fact('Account', a.email), fact('Connected with', `${NAMES[s.id]} · ${VIA[a.via] || a.via || '—'}`),
      fact('Status', ok ? 'Working' : 'Needs a new sign-in'));
    const back = button('‹ Settings', () => render(), 'wst-back');
    const acts = el('div', null, 'wst-actions');
    if (!ok) acts.append(button('Sign in again', () => { close(); opts.connect(s.id); }, 'wz-button'));
    if (a.disconnect) acts.append(button('Disconnect', () => askDisconnect(s, a), 'wz-button secondary wst-danger'));
    else acts.append(el('p', `Update the ${NAMES[s.id]} app to disconnect from Mail, or open the ${NAMES[s.id]} app.`, 'wst-muted'));
    frame(a.label || a.email, back, facts, acts);
  }
  function askDisconnect(s, a) {
    const msg = el('p', `Mail, Calendar and your agents stop using ${a.email}. Your mail stays with ${NAMES[s.id]}; you can connect it again any time.`, 'wst-text');
    const err = el('p', '', 'wst-bad', { role: 'alert' });
    const no = button('Cancel', () => manage(s, a), 'wz-button secondary');
    const yes = button('Disconnect', async () => {
      yes.disabled = no.disabled = true; err.textContent = '';
      try {
        await client(s.id).api(a.disconnect, {});
        await opts.changed();
        await load();
        render();  // back to Settings, the tile gone
        say(`Disconnected ${a.email}.`);
      } catch (e) { err.textContent = e.message; yes.disabled = no.disabled = false; }
    }, 'wz-button secondary wst-danger');
    const acts = el('div', null, 'wst-actions'); acts.append(no, yes);
    frame(`Disconnect ${a.email}?`, msg, err, acts);
  }

  window.WizardMailSettings = { open, close };
})();
