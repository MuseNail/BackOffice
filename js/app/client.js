// ── client.js — Back Office CLIENT app entry ──────────────────────────────────
// A slim workspace for a "client" role: SUGGEST a category/vendor/invoice + a note on
// waiting transactions (the owner reviews & approves), and VIEW invoices and reports
// read-only. Same auth/sync/store as the full app; the ONLY write is the narrow
// /suggest endpoint. Loaded from client.html (body.bo-client). No import, no posting.
import { ORIGIN } from './config.js';
import { getToken, getActiveBiz, setActiveBiz, getUser, getBusinesses, clearSession } from './session.js';
import { openBusiness, setStatusListener, api, syncNow } from './sync.js';
import { initLock, sessionResumable } from './lock.js';
import { entities, subscribe, usesInvoices } from './store.js';
import { el, clear, toast, fmtMoney } from './ui.js';
import { combobox } from './combobox.js';
import { parseMoney } from './lib/money.js';
import { accountLabel } from './lib/coa-templates.js';
import * as login from './views/login.js';
import * as invoices from './views/invoices.js';
import * as reports from './views/reports.js';

const TABS = [['suggest', 'Suggest', 'checklist'], ['invoices', 'Invoices', 'request_quote'], ['reports', 'Reports', 'monitoring']];
let opened = '';
let current = null;   // {unmount} of the active tab view

function route() {
  const root = document.getElementById('view');
  const tabs = document.getElementById('clienttabs');
  const chip = document.getElementById('clientchip');

  if (getToken() && !sessionResumable()) clearSession();   // closed / 30-min idle → re-login
  if (!getToken()) {
    current?.unmount?.(); current = null;
    tabs.style.display = 'none'; chip.style.display = 'none';
    root.replaceChildren(); login.render(root);
    return;
  }
  const m = (location.hash || '').match(/^#\/b\/([a-z0-9-]+)(?:\/(\w+))?/);
  const biz = m ? m[1] : getBusinesses()[0]?.id;
  if (!biz) { current?.unmount?.(); current = null; tabs.style.display = 'none'; root.replaceChildren(el('p', { class: 'sub', style: 'padding:24px' }, 'No business is assigned to your account yet — ask the owner to add you.')); return; }
  let tab = m && m[2] ? m[2] : 'suggest';
  if (!TABS.some(t => t[0] === tab)) tab = 'suggest';
  if (opened !== biz) { opened = biz; setActiveBiz(biz); openBusiness(biz).catch(console.error); }

  chip.style.display = 'flex';
  document.getElementById('clientname').textContent = getUser()?.name || '';
  // Brand the app for THIS client's business (e.g. "TIE Books"), not a fixed name.
  const bizObj = getBusinesses().find(b => b.id === biz);
  const brand = bizObj?.name ? `${bizObj.name.trim().split(/\s+/)[0]} Books` : 'Books';
  const brandEl = document.getElementById('clientbrand');
  if (brandEl) brandEl.textContent = brand;
  document.title = `${brand} — Client`;

  tabs.style.display = 'flex';
  clear(tabs).append(...TABS.map(([id, label, icon]) => el('button', {
    class: 'clienttab' + (id === tab ? ' on' : ''),
    onclick: () => { location.hash = `#/b/${biz}/${id}`; },
  }, el('span', { class: 'ms' }, icon), label)));

  current?.unmount?.(); root.replaceChildren();
  if (tab === 'invoices') { invoices.render(root); current = invoices; }
  else if (tab === 'reports') { reports.render(root); current = reports; }
  else { suggestView.render(root); current = suggestView; }
}

// ── Suggest screen ────────────────────────────────────────────────────────────
// Per-row DRAFT state kept across redraws so an in-progress pick, a typed-in NEW
// vendor/account name, or a split is never wiped when the store changes underneath the
// list (that silent wipe was the old "my suggestion didn't go through" bug). A draft is
// seeded from the row's current suggested* fields the first time the row is opened.
const drafts = new Map();
const editing = new Set();   // already-suggested rows the client re-opened to edit
function draftFor(row) {
  let d = drafts.get(row.id);
  if (!d) {
    const sp = Array.isArray(row.suggestedSplit) ? row.suggestedSplit : [];
    d = {
      vendorId: row.suggestedVendorId || '', vendorName: row.suggestedVendorName || '',
      accountId: row.suggestedAccountId || '', accountName: row.suggestedAccountName || '',
      invoiceId: row.suggestedInvoiceId || '', note: row.clientNote || '',
      splitMode: sp.length >= 2,
      split: sp.length >= 2 ? sp.map(l => ({ accountId: l.accountId || '', accountName: l.accountName || '', amt: ((l.amountCents || 0) / 100).toFixed(2) }))
                            : [{ accountId: '', accountName: '', amt: '' }, { accountId: '', accountName: '', amt: '' }],
      sent: null,   // null | 'ok' | 'err'
    };
    drafts.set(row.id, d);
  }
  return d;
}

let suggestCtrl = null, suggestSearch = null;

const suggestView = (() => {
  let unsub = null;
  let deferTimer = 0;
  let cf = { q: '', view: 'needs', dir: 'all' };
  function render(root) {
    cf = { q: '', view: 'needs', dir: 'all' };
    drafts.clear(); editing.clear();
    const body = el('div');
    // A store change rebuilds the list. Never rebuild while the client is mid-edit — an
    // open dropdown (its panel is portaled to <body>) or a focused field would lose the
    // in-progress pick/keystroke. Defer the redraw until they're done, then run it once.
    let dirty = false;
    const busy = () => document.querySelector('.cbx-panel') || (body.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName || ''));
    const draw = () => {
      if (busy()) {
        dirty = true;
        if (!deferTimer) deferTimer = setInterval(() => {
          if (!busy()) { clearInterval(deferTimer); deferTimer = 0; if (dirty) { dirty = false; drawSuggest(body, cf, draw); } }
        }, 250);
        return;
      }
      dirty = false; drawSuggest(body, cf, draw);
    };
    // The search box lives ABOVE the body, built once, so typing/redraws never lose focus.
    suggestSearch = el('input', { class: 'field-input', type: 'search', placeholder: 'Search description, amount, or vendor…', style: 'max-width:300px;margin:0', value: cf.q, oninput: (e) => { cf.q = e.target.value; draw(); } });
    suggestCtrl = el('div');   // progress + segmented view (rebuilt each draw for live counts)
    root.append(
      el('h2', {}, 'Suggest'),
      el('p', { class: 'sub' }, 'Tell the owner what each waiting transaction is — a vendor, an account (or a split across accounts), and a note. These are suggestions; the owner reviews and approves. Nothing here posts to the books.'),
      suggestCtrl,
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px' },
        suggestSearch,
        el('select', { class: 'field-input', style: 'margin:0;width:auto;min-width:130px', onchange: (e) => { cf.dir = e.target.value; draw(); } },
          ...[['all', 'Money in & out'], ['in', 'Money in'], ['out', 'Money out']].map(([v, l]) => el('option', { value: v, selected: cf.dir === v }, l)))),
      body);
    unsub = subscribe(draw);
    draw();
  }
  function unmount() { unsub?.(); unsub = null; if (deferTimer) { clearInterval(deferTimer); deferTimer = 0; } suggestCtrl = null; suggestSearch = null; }
  return { render, unmount };
})();

function acctGroups() {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  const bankish = (a) => a.qbType === 'BANK' || a.qbType === 'CCARD';
  const cats = entities('account').filter(a => a.active !== false && !bankish(a)).sort((a, b) => accountLabel(a, byId).localeCompare(accountLabel(b, byId)));
  return [{ label: 'Accounts', items: cats.map(a => ({ value: a.id, label: accountLabel(a, byId) })) }];
}

// Match a suggest row against the search box: its description, its amount (e.g. "190.64"),
// or the name of the vendor it's currently suggested to.
function suggestMatches(s, q, vendorsById) {
  if (!q) return true;
  if ((s.desc || '').toLowerCase().includes(q)) return true;
  if ((Math.abs(s.amountCents || 0) / 100).toFixed(2).includes(q)) return true;
  const v = s.suggestedVendorId && vendorsById.get(s.suggestedVendorId);
  if (v && (v.name || '').toLowerCase().includes(q)) return true;
  return false;
}

// A proposed split → the payload lines (positive cents; an id wins over a typed name).
function splitPayload(row, d) {
  return d.split
    .map(l => {
      // Prefer the LIVE combobox (l._sel) so a still-focused account line isn't sent truncated.
      const id = l._sel ? (l._sel.value || '') : (l.accountId || '');
      const name = id ? '' : (l._sel ? (l._sel.inputText || '').trim() : (l.accountName || '').trim());
      return { accountId: id, accountName: name, amountCents: parseMoney(l.amt) || 0 };
    })
    .filter(l => (l.accountId || l.accountName) && l.amountCents > 0);
}
function splitOk(row, d) {
  const p = splitPayload(row, d);
  return p.length >= 2 && p.reduce((s, l) => s + l.amountCents, 0) === Math.abs(row.amountCents);
}

function drawSuggest(body, cf, draw) {
  const allPending = entities('staged').filter(s => s.status === 'pending' && !s.syncApp);
  const needsN = allPending.filter(s => !s.suggestedAt).length;
  const doneN = allPending.length - needsN;
  if (suggestCtrl) {
    const seg = (v, label, n) => el('button', { class: 'seg-btn' + (cf.view === v ? ' on' : ''), onclick: () => { cf.view = v; draw(); } }, label, el('span', { class: 'seg-cnt' }, String(n)));
    const pct = allPending.length ? Math.round(doneN / allPending.length * 100) : 0;
    clear(suggestCtrl).append(
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin:0 0 10px' },
        el('div', { class: 'sugg-bar', style: 'flex:1;max-width:280px' }, el('div', { class: 'sugg-bar-fill', style: `width:${pct}%` })),
        el('span', { class: 'sub', style: 'margin:0;font-weight:600' }, `${doneN} of ${allPending.length} done`)),
      el('div', { class: 'seg' }, seg('needs', 'Needs you', needsN), seg('done', 'Suggested', doneN), seg('all', 'All', allPending.length)));
  }
  if (!allPending.length) { clear(body).append(el('p', { class: 'sub' }, 'Nothing waiting right now — when the owner imports transactions they’ll appear here.')); return; }
  const vendorsById = new Map(entities('vendor').map(v => [v.id, v]));
  const q = (cf.q || '').trim().toLowerCase();
  const rows = allPending.filter(s => {
    if (cf.view === 'needs' && s.suggestedAt && !editing.has(s.id)) return false;
    if (cf.view === 'done' && !s.suggestedAt) return false;
    if (cf.dir === 'in' && !(s.amountCents > 0)) return false;
    if (cf.dir === 'out' && !(s.amountCents < 0)) return false;
    return suggestMatches(s, q, vendorsById);
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!rows.length) { clear(body).append(el('p', { class: 'sub' }, cf.view === 'needs' ? 'All caught up — every waiting transaction has a suggestion. Switch to “All” to review them.' : 'No transactions match your search or filters.')); return; }
  const vendors = entities('vendor').slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const invs = entities('invoice').slice().sort((a, b) => String(b.number || '').localeCompare(String(a.number || '')));
  const showInvoices = usesInvoices();
  clear(body).append(...rows.map(row => (row.suggestedAt && !editing.has(row.id))
    ? suggestRowDone(row, draw)
    : suggestRowFull(row, { vendors, invs, showInvoices, draw })));
}

// A collapsed, already-suggested row: a one-line summary of what the client proposed,
// with Edit to re-open the full editor.
function suggestRowDone(row, draw) {
  const byId = new Map(entities('account').map(a => [a.id, a]));
  let summary;
  if (row.suggestedSplit && row.suggestedSplit.length >= 2) summary = `Split across ${row.suggestedSplit.length} accounts`;
  else {
    const acct = row.suggestedAccountId ? (byId.get(row.suggestedAccountId)?.name || 'account') : (row.suggestedAccountName || '');
    const vend = row.suggestedVendorId ? (entities('vendor').find(v => v.id === row.suggestedVendorId)?.name || '') : (row.suggestedVendorName || '');
    summary = acct ? `You suggested ${acct}` : (vend ? `Vendor: ${vend}` : (row.clientNote ? 'Note left for the owner' : 'Suggested'));
  }
  const amtEl = el('span', { class: 'revamt num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 }));
  return el('div', { class: 'revrow sugg-done' },
    el('div', { style: 'display:flex;align-items:center;gap:9px' },
      el('span', { class: 'sugg-dot ok' }),
      el('span', { class: 'revdate' }, row.date),
      el('span', { class: 'revdesc', style: 'flex:1' }, row.desc || ''),
      amtEl),
    el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap' },
      el('span', { class: 'pill green' }, '✓ Suggested'),
      el('span', { class: 'sub', style: 'margin:0' }, summary),
      el('button', { class: 'btn sm ghost', style: 'margin-left:auto', onclick: () => { editing.add(row.id); drafts.delete(row.id); draw(); } }, 'Edit')));
}

// The full editor for a row that still needs the client (or one they re-opened to edit).
function suggestRowFull(row, { vendors, invs, showInvoices, draw }) {
  const d = draftFor(row);
  const groups = acctGroups();
  const field = (label, node) => el('div', { class: 'rvf' }, el('label', { class: 'field-label', style: 'margin:0 0 2px' }, label), node);

  const btn = el('button', { class: 'btn sm' }, 'Suggest');

  const venSel = combobox({ groups: [{ label: '', items: vendors.map(v => ({ value: v.id, label: v.name })) }], value: d.vendorId || '', text: d.vendorId ? '' : d.vendorName, placeholder: 'Pick or type a new vendor…', minWidth: 0, freeText: true, emptyText: 'No match — suggested as a NEW vendor' });
  venSel.addEventListener('change', () => { d.vendorId = venSel.value; d.vendorName = venSel.value ? '' : venSel.inputText; });

  let acctField = null, acctSel = null;
  if (!d.splitMode) {
    acctSel = combobox({ groups, value: d.accountId || '', text: d.accountId ? '' : d.accountName, placeholder: 'Search or type a new account…', minWidth: 0, freeText: true, emptyText: 'No match — suggested as a NEW account' });
    acctSel.addEventListener('change', () => { d.accountId = acctSel.value; d.accountName = acctSel.value ? '' : acctSel.inputText; });
    acctField = field('Account', acctSel);
  }

  const invSel = showInvoices ? combobox({ groups: [{ label: '', items: [{ value: '', label: '— none —' }, ...invs.map(i => ({ value: i.id, label: `#${i.number || i.id} · ${(i.clientName || '').slice(0, 28)}` }))] }], value: d.invoiceId || '', placeholder: 'Find invoice…', minWidth: 0 }) : null;
  if (invSel) invSel.addEventListener('change', () => { d.invoiceId = invSel.value; });

  const note = el('textarea', { class: 'field-input', rows: '2', placeholder: 'Note for the owner…', style: 'margin:0;width:100%;min-width:0;resize:vertical' });
  note.value = d.note || '';
  note.addEventListener('input', () => { d.note = note.value; });

  const splitNode = d.splitMode ? splitBlock(row, d, groups, btn) : null;
  const splitToggle = el('button', { class: 'sugg-splittog' + (d.splitMode ? ' on' : ''), type: 'button', title: 'Split this across several accounts',
    onclick: () => { d.splitMode = !d.splitMode; if (d.splitMode && d.split.length < 2) d.split = [{ accountId: '', accountName: '', amt: '' }, { accountId: '', accountName: '', amt: '' }]; draw(); } },
    el('span', { class: 'ms', style: 'font-size:15px' }, 'call_split'), d.splitMode ? 'Split on' : 'Split');

  const errBox = el('div', { class: 'sugg-sent err', hidden: d.sent !== 'err' }, el('span', { class: 'ms', style: 'font-size:15px' }, 'error'), el('span', {}, 'Couldn’t send. Check your connection and try again.'));

  if (d.sent === 'ok') { btn.textContent = 'Sent ✓'; btn.classList.add('green'); btn.disabled = true; }
  else if (d.splitMode) btn.disabled = !splitOk(row, d);
  btn.onclick = async () => {
    if (d.splitMode && !splitOk(row, d)) { toast('The split needs to add up first', 'err'); return; }
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
    try {
      const biz = getActiveBiz();
      // Sync the draft from the LIVE fields at click time. A freeText combobox only writes its
      // typed text to the draft when it CLOSES, so clicking Suggest while a field is still
      // focused would otherwise send a stale/partial name — that's how "person" arrived as
      // "perso". Reading .inputText/.value here captures exactly what's in the box.
      d.vendorId = venSel.value || ''; d.vendorName = d.vendorId ? '' : (venSel.inputText || '').trim();
      if (acctSel) { d.accountId = acctSel.value || ''; d.accountName = d.accountId ? '' : (acctSel.inputText || '').trim(); }
      if (invSel) d.invoiceId = invSel.value || '';
      d.note = note.value || '';
      const payload = { stagedId: row.id, clientNote: (d.note || '').trim(), suggestedVendorId: d.vendorId || '', suggestedVendorName: d.vendorId ? '' : (d.vendorName || '').trim(), suggestedInvoiceId: d.invoiceId || '' };
      if (d.splitMode) { payload.suggestedSplit = splitPayload(row, d); payload.suggestedAccountId = ''; payload.suggestedAccountName = ''; }
      else { payload.suggestedAccountId = d.accountId || ''; payload.suggestedAccountName = d.accountId ? '' : (d.accountName || '').trim(); payload.suggestedSplit = []; }
      const res = await api(`/b/${biz}/suggest`, { method: 'POST', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('failed');
      d.sent = 'ok'; editing.delete(row.id); toast('Suggestion sent to the owner'); draw();
    } catch { d.sent = 'err'; btn.disabled = false; btn.textContent = label; errBox.hidden = false; toast('Couldn’t send — check your connection and try again', 'err'); }
  };

  const dot = el('span', { class: 'sugg-dot ' + (row.suggestedAt ? 'ok' : 'needs') });
  const amtEl = el('span', { class: 'revamt num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 }));
  return el('div', { class: 'revrow' },
    el('div', { class: 'revmain' },
      el('div', { class: 'revtop' }, dot, el('span', { class: 'revdate' }, row.date), el('span', { class: 'revdesc', style: 'flex:1' }, row.desc || ''), amtEl),
      el('div', { class: 'revfields' }, field('Vendor', venSel), acctField, invSel ? field('Invoice', invSel) : null),
      splitNode,
      el('div', { class: 'revnote' }, el('label', { class: 'field-label', style: 'margin:0 0 2px' }, 'Note'), note),
      errBox,
      el('div', { class: 'sugg-foot' }, splitToggle, el('span', { style: 'flex:1' }), btn)));
}

// The in-row split editor: 2+ account lines that must add up to the charge before the
// row can be suggested. Mirrors the owner's Review split (same balance check).
function splitBlock(row, d, groups, btn) {
  const total = Math.abs(row.amountCents);
  const linesBox = el('div');
  const bal = el('div', { class: 'split-remind' });
  const updateBal = () => {
    const assigned = d.split.reduce((s, l) => s + (parseMoney(l.amt) || 0), 0);
    const left = total - assigned;
    const ok = splitOk(row, d);
    bal.className = 'split-remind ' + (ok ? 'ok' : 'bad');
    clear(bal).append(
      el('span', {}, ok ? 'Balanced' : (left < 0 ? 'Over by' : 'Remaining to assign')),
      el('span', {}, ok ? fmtMoney(total) + ' ✓' : fmtMoney(Math.abs(left))));
    if (btn && d.sent !== 'ok') btn.disabled = !ok;
  };
  const renderLines = () => clear(linesBox).append(...d.split.map((l) => {
    const sel = combobox({ groups, value: l.accountId || '', text: l.accountId ? '' : l.accountName, placeholder: 'Account…', minWidth: 0, freeText: true, emptyText: 'New account — the owner adds it' });
    l._sel = sel;   // keep a handle so splitPayload can read the LIVE typed text at send time
    sel.style.cssText = 'flex:1;min-width:0';
    sel.addEventListener('change', () => { l.accountId = sel.value; l.accountName = sel.value ? '' : sel.inputText; updateBal(); });
    const amt = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: '$', style: 'width:92px;text-align:right;margin:0', value: l.amt || '' });
    amt.addEventListener('input', () => { l.amt = amt.value; updateBal(); });
    const rm = el('button', { class: 'sugg-rm', type: 'button', title: 'Remove line', onclick: () => { if (d.split.length > 2) { const i = d.split.indexOf(l); if (i >= 0) d.split.splice(i, 1); renderLines(); updateBal(); } } }, '×');
    return el('div', { class: 'sugg-splitrow' }, sel, amt, rm);
  }));
  const add = el('button', { class: 'btn sm ghost', type: 'button', onclick: () => { d.split.push({ accountId: '', accountName: '', amt: '' }); renderLines(); updateBal(); } }, '＋ Add account');
  renderLines(); updateBal();
  return el('div', { class: 'sugg-split' },
    el('div', { class: 'field-label', style: 'margin:0 0 4px' }, 'Split across accounts'),
    linesBox, add, bal);
}

// A loud, persistent banner whenever a suggestion hasn't synced or the app is offline — so
// you never keep working unaware that nothing's saving. "Sync now" forces a reconnect + flush.
function renderSyncBanner(state, pending, failed) {
  const show = state !== 'synced' && (pending || failed || state === 'offline');
  let bar = document.getElementById('sync-banner');
  if (!show) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'sync-banner'; document.body.appendChild(bar); }
  const n = pending + failed;
  bar.className = 'sync-banner ' + (state === 'offline' ? 'offline' : 'attention');
  const msg = state === 'offline'
    ? `You’re offline — ${n} change${n === 1 ? '' : 's'} waiting to sync. They’ll save when you reconnect.`
    : `${n} change${n === 1 ? '' : 's'} haven’t synced yet.`;
  const icon = el('span', { class: 'ms' }, state === 'offline' ? 'cloud_off' : 'sync_problem');
  const text = el('span', { style: 'flex:1' }, msg);
  const btn = el('button', { class: 'sync-banner-btn', onclick: () => { btn.disabled = true; btn.textContent = 'Syncing…'; Promise.resolve(syncNow()).finally(() => setTimeout(() => { btn.disabled = false; btn.textContent = 'Sync now'; }, 800)); } }, 'Sync now');
  clear(bar).append(icon, text, btn);
}

function boot() {
  setStatusListener((s, info) => {
    const pending = info?.pending || 0, failed = info?.failed || 0, n = pending + failed;
    const pill = document.getElementById('syncpill');
    if (pill) {
      pill.textContent = s === 'synced' ? 'Synced' : s === 'offline' ? (n ? `Offline · ${n}` : 'Offline') : `Unsynced · ${n}`;
      pill.className = 'syncpill ' + (s === 'synced' ? 'synced' : s === 'attention' ? 'attention' : 'offline');
    }
    renderSyncBanner(s, pending, failed);
  });
  document.getElementById('clientlogout').addEventListener('click', async () => {
    try { await fetch(ORIGIN + '/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); } catch { /* signing out anyway */ }
    clearSession(); location.hash = ''; location.reload();
  });
  window.addEventListener('hashchange', route);
  initLock(route);   // auto sign-out on app close / 30-min idle
  route();
}
boot();
