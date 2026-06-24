// ── client.js — Back Office CLIENT app entry ──────────────────────────────────
// A slim workspace for a "client" role: SUGGEST a category/vendor/invoice + a note on
// waiting transactions (the owner reviews & approves), and VIEW invoices and reports
// read-only. Same auth/sync/store as the full app; the ONLY write is the narrow
// /suggest endpoint. Loaded from client.html (body.bo-client). No import, no posting.
import { ORIGIN } from './config.js';
import { getToken, getActiveBiz, setActiveBiz, getUser, getBusinesses, clearSession } from './session.js';
import { openBusiness, setStatusListener, api } from './sync.js';
import { initLock, sessionResumable } from './lock.js';
import { entities, subscribe } from './store.js';
import { el, clear, toast, fmtMoney } from './ui.js';
import { combobox } from './combobox.js';
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
const suggestView = (() => {
  let unsub = null;
  let cf = { q: '', status: 'all', dir: 'all' };
  function render(root) {
    cf = { q: '', status: 'all', dir: 'all' };
    const body = el('div');
    const draw = () => drawSuggest(body, cf);
    // The search box + filters live ABOVE the body, built once, so typing/redraws never
    // lose focus (the body is the only thing re-rendered on a store change).
    const search = el('input', { class: 'field-input', type: 'search', placeholder: 'Search description, amount, or vendor…', style: 'max-width:300px;margin:0', value: cf.q, oninput: (e) => { cf.q = e.target.value; draw(); } });
    const sel = (key, opts) => el('select', { class: 'field-input', style: 'margin:0;width:auto;min-width:130px', onchange: (e) => { cf[key] = e.target.value; draw(); } },
      ...opts.map(([v, l]) => el('option', { value: v, selected: cf[key] === v }, l)));
    root.append(
      el('h2', {}, 'Suggest categories'),
      el('p', { class: 'sub' }, 'Pick a vendor and account for each waiting transaction and leave a note for the owner. These are suggestions — the owner reviews and approves; nothing here posts to the books. If a vendor isn’t listed, leave it blank and mention it in the note.'),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px' },
        search,
        sel('status', [['all', 'Any status'], ['needs', 'Needs suggestion'], ['suggested', 'Suggested']]),
        sel('dir', [['all', 'Money in & out'], ['in', 'Money in'], ['out', 'Money out']])),
      body);
    unsub = subscribe(draw);
    draw();
  }
  function unmount() { unsub?.(); unsub = null; }
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

function drawSuggest(body, cf = { q: '', status: 'all', dir: 'all' }) {
  const biz = getActiveBiz();
  const allPending = entities('staged').filter(s => s.status === 'pending' && !s.syncApp);
  if (!allPending.length) { clear(body).append(el('p', { class: 'sub' }, 'Nothing waiting right now — when the owner imports transactions they’ll appear here.')); return; }
  const vendorsById = new Map(entities('vendor').map(v => [v.id, v]));
  const q = (cf.q || '').trim().toLowerCase();
  const pending = allPending.filter(s => {
    if (cf.dir === 'in' && !(s.amountCents > 0)) return false;
    if (cf.dir === 'out' && !(s.amountCents < 0)) return false;
    if (cf.status === 'suggested' && !s.suggestedAt) return false;
    if (cf.status === 'needs' && s.suggestedAt) return false;
    return suggestMatches(s, q, vendorsById);
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!pending.length) { clear(body).append(el('p', { class: 'sub' }, 'No transactions match your search or filters.')); return; }
  const vendors = entities('vendor').slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const invs = entities('invoice').slice().sort((a, b) => String(b.number || '').localeCompare(String(a.number || '')));
  const groups = acctGroups();
  const field = (label, node) => el('div', { class: 'rvf' }, el('label', { class: 'field-label', style: 'margin:0 0 2px' }, label), node);

  clear(body).append(...pending.map(row => {
    const venSel = combobox({ groups: [{ label: '', items: vendors.map(v => ({ value: v.id, label: v.name })) }], value: row.suggestedVendorId || '', placeholder: 'Pick a vendor…', minWidth: 180 });
    const acctSel = combobox({ groups, value: row.suggestedAccountId || '', placeholder: 'Search accounts…', minWidth: 220 });
    const invSel = combobox({ groups: [{ label: '', items: [{ value: '', label: '— none —' }, ...invs.map(i => ({ value: i.id, label: `#${i.number || i.id} · ${(i.clientName || '').slice(0, 28)}` }))] }], value: row.suggestedInvoiceId || '', placeholder: 'Find invoice…', minWidth: 190 });
    const note = el('textarea', { class: 'field-input', rows: '2', placeholder: 'Note for the owner…', style: 'margin:0;min-width:200px;resize:vertical' });
    note.value = row.clientNote || '';
    const chip = row.suggestedAt ? el('span', { class: 'pill green' }, 'Suggested ✓') : el('span', { class: 'pill gray' }, 'Needs your suggestion');
    const btn = el('button', { class: 'btn sm', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const res = await api(`/b/${biz}/suggest`, { method: 'POST', body: JSON.stringify({
          stagedId: row.id, suggestedAccountId: acctSel.value, suggestedVendorId: venSel.value, suggestedInvoiceId: invSel.value, clientNote: note.value.trim(),
        }) });
        if (!res.ok) throw new Error('failed');
        toast('Suggestion sent to the owner');
      } catch { toast('Couldn’t save — try again', 'err'); btn.disabled = false; btn.textContent = 'Suggest'; }
    } }, 'Suggest');

    const amtEl = el('span', { class: 'revamt num ' + (row.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(row.amountCents, { sign: row.amountCents > 0 }));
    return el('div', { class: 'revrow' },
      el('div', { class: 'revbody' },
        el('div', { class: 'revmain' },
          el('div', { class: 'revtop' },
            el('span', { class: 'revdate' }, row.date),
            el('span', { class: 'revdesc' }, row.desc || '')),
          el('div', { class: 'revfields' },
            field('Vendor', venSel), field('Account', acctSel), field('Invoice', invSel), field('Note', note))),
        el('div', { class: 'revside' },
          el('div', { class: 'revside-top' }, chip, amtEl),
          el('div', { class: 'revside-actions' }, btn))));
  }));
}

function boot() {
  setStatusListener(s => { const pill = document.getElementById('syncpill'); if (pill) { pill.textContent = s === 'synced' ? 'Synced' : 'Offline'; pill.className = 'syncpill ' + s; } });
  document.getElementById('clientlogout').addEventListener('click', async () => {
    try { await fetch(ORIGIN + '/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); } catch { /* signing out anyway */ }
    clearSession(); location.hash = ''; location.reload();
  });
  window.addEventListener('hashchange', route);
  initLock(route);   // auto sign-out on app close / 30-min idle
  route();
}
boot();
