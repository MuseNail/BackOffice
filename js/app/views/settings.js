// ── view: settings — users, roles, signed-in devices ────────────────
// Management UI renders only for owner/manager sessions; the server enforces
// the same rule, this is just honest UI. Muse sync + IIF export land M11/M12.
import { el, clear, toast, fmtMoney, acctAmount, modal } from '../ui.js';
import { api, dispatch, saveOrphanTo } from '../sync.js';
import { getBusinesses, roleFor, getUser } from '../session.js';
import { describeWrite } from '../lib/orphan-recovery.js';
import { getState, entities, byId, subscribe, usesInvoices, usesMuseSync, getStateBiz } from '../store.js';
import { parseMoney } from '../lib/money.js';
import { MUSE_SYNC_TYPES } from '../lib/musesync.js';
import { accountLabel } from '../lib/coa-templates.js';
import { buildIif, buildListsIif } from '../lib/qb-iif.js';
import { parseIifAccounts } from '../lib/qb-iif-import.js';
import { qbSyncSnapshot, qbSyncDiff, qbSyncCounts } from '../lib/qb-sync.js';
import { buildQbImport } from '../lib/qb-history-import.js';
import { ORIGIN, LS } from '../config.js';
import { drawErrorLog, drawBugAlerts } from '../diagnostics.js';

const ROLES = ['owner', 'manager', 'bookkeeper', 'client', 'viewer'];
const ROLE_HELP = { owner: 'everything', manager: 'everything but deleting the business', bookkeeper: 'edit the books', client: 'suggest categories + notes, view reports/invoices (client app)', viewer: 'read-only' };

// Settings is a MENU now — each row opens its section as its OWN window (one window
// per view, like every other tab). SETTINGS_NAV is the single source of truth: the menu
// renders from it, the section views read their title/icon from it, and main.js uses it
// for each window's title bar + to register the views.
export const SETTINGS_NAV = [
  { key: 'set_team', title: 'Team & access', icon: 'group', desc: 'Users, roles, and signed-in devices.' },
  { key: 'set_modules', title: 'Modules', icon: 'tune', desc: 'Optional features and AI spending.' },
  { key: 'set_qb', title: 'QuickBooks', icon: 'sync_alt', desc: 'Export, sync lists, and import to/from QuickBooks Desktop.' },
  { key: 'set_integrations', title: 'Integrations', icon: 'hub', desc: 'Connections to other apps (Muse salon sync).' },
  { key: 'set_books', title: 'Close the books', icon: 'lock', desc: 'Lock finished months so they can’t be changed.' },
  { key: 'set_data', title: 'Data & maintenance', icon: 'shield', desc: 'Activity log, plus recovery of held and rejected writes.' },
  { key: 'set_diagnostics', title: 'Diagnostics', icon: 'bug_report', desc: 'Automatic error log and bug-alert notifications.' },
];

// Cards per section, and whether each is store-driven (re-run on every store change) or
// one-shot (async / holds a file input → drawn once). All draw fns tolerate (card, biz).
const SECTION_CARDS = {
  set_team: [{ draw: drawUsers, live: false }, { draw: drawDevices, live: false }],
  set_modules: [{ draw: drawFeaturesCard, live: true }, { draw: drawAICard, live: true }],
  set_qb: [{ draw: drawQbCard, live: true }, { draw: drawQbListSyncCard, live: true }, { draw: drawQbImportCard, live: false }, { draw: drawQbHistoryCard, live: false }],
  set_integrations: [{ draw: drawMuseCard, live: true, onlyIf: usesMuseSync }],
  set_books: [{ draw: drawLocksCard, live: true }],
  set_data: [{ draw: drawAuditCard, live: false }, { draw: drawFailedOps, live: true }],
  set_diagnostics: [{ draw: drawErrorLog, live: false }, { draw: drawBugAlerts, live: false }],
};

export function render(root) {
  const biz = getStateBiz();
  const myRole = roleFor(biz);
  const bizName = getState().meta?.name || getBusinesses().find(b => b.id === biz)?.name || biz;
  root.append(el('h2', {}, `Settings — ${bizName}`));
  if (!['owner', 'manager'].includes(myRole)) {
    root.append(el('p', { class: 'sub' }, 'Users and devices are managed by the owner.'));
    return;
  }
  root.append(el('p', { class: 'sub' }, 'Pick a section — each opens in its own window.'));
  const menu = el('div', { class: 'set-menu' });
  for (const sct of SETTINGS_NAV) {
    if (sct.key === 'set_integrations' && !usesMuseSync()) continue;   // hide empty integrations
    menu.append(el('button', { class: 'set-menu-row', type: 'button', onclick: () => { location.hash = `#/b/${biz}/${sct.key}`; } },
      el('span', { class: 'ms set-menu-ic' }, sct.icon),
      el('span', { style: 'flex:1' }, el('div', { class: 'set-menu-t' }, sct.title), el('div', { class: 'sub', style: 'margin:0' }, sct.desc)),
      el('span', { class: 'ms set-menu-go' }, 'chevron_right')));
  }
  root.append(menu);
}
export function unmount() {}

// One settings section = its own window. Reuses the draw*Card builders below; store-driven
// cards re-run on a subscription, one-shot cards are drawn once (same split as the old page).
function sectionView(key) {
  let unsub = null;
  const meta = SETTINGS_NAV.find(s => s.key === key);
  return {
    render(root) {
      const biz = getStateBiz();
      root.append(el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px' },
        el('a', { class: 'btn sm ghost', href: `#/b/${biz}/settings` }, '← All settings'),
        el('h2', { style: 'margin:0' }, meta?.title || 'Settings')));
      if (!['owner', 'manager'].includes(roleFor(biz))) { root.append(el('p', { class: 'sub' }, 'Managed by the owner.')); return; }
      const live = [];
      let shown = 0;
      for (const c of (SECTION_CARDS[key] || [])) {
        if (c.onlyIf && !c.onlyIf()) continue;
        const card = el('div', { class: 'card', style: 'max-width:680px' });
        root.append(card);
        c.draw(card, biz);
        if (c.live) live.push(() => c.draw(card, biz));
        shown++;
      }
      if (!shown) root.append(el('p', { class: 'sub' }, 'Nothing to set up here for this business.'));
      if (live.length) unsub = subscribe(() => live.forEach(fn => fn()));
    },
    unmount() { unsub?.(); unsub = null; },
  };
}
export const setTeam = sectionView('set_team');
export const setModules = sectionView('set_modules');
export const setQb = sectionView('set_qb');
export const setIntegrations = sectionView('set_integrations');
export const setBooks = sectionView('set_books');
export const setData = sectionView('set_data');
export const setDiagnostics = sectionView('set_diagnostics');

// ── Audit log (server-stored: who changed which transaction, when) ──
async function drawAuditCard(card, biz) {
  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Audit log'),
    el('p', { class: 'sub' }, 'Recent changes to transactions — who did what, and when.'));
  let entries = [], users = [];
  try {
    entries = ((await (await api(`/b/${biz}/_audit?limit=100`)).json()).entries) || [];
    users = ((await (await api(`/registry/users?businessId=${biz}`)).json()).users) || [];
  } catch { card.append(el('p', { class: 'sub' }, 'Could not load the audit log.')); return; }
  const nameById = new Map(users.map(u => [u.id, u.name]));
  const me = getUser(); if (me?.id) nameById.set(me.id, me.name);
  if (!entries.length) { card.append(el('p', { class: 'sub' }, 'No transaction changes recorded yet.')); return; }
  const fmtWhen = ts => { try { return new Date(ts).toLocaleString(); } catch { return '—'; } };
  const desc = e => `${e.action}${e.payee ? ' “' + e.payee + '”' : ''}${e.amountCents ? ' · ' + fmtMoney(e.amountCents) : ''}`;
  const rows = entries.map(e => el('tr', {},
    el('td', {}, fmtWhen(e.at)),
    el('td', {}, nameById.get(e.by) || e.by || '—'),
    el('td', {}, desc(e))));
  card.append(el('div', { style: 'overflow:auto;max-height:360px' }, el('table', { class: 'data xl' },
    el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'User'), el('th', {}, 'Change'))),
    el('tbody', {}, ...rows))));
}

// ── Held & rejected writes (dead-letter recovery) ──
// Two kinds land here: ORPHANS — writes with no business tag, which the app refuses to guess
// a destination for (a wrong guess posted a $4k txn into the wrong books); the owner files
// each to its books with the picker. And REJECTIONS — writes a business's server turned down
// (stale/blocked edit), kept so nothing is silently lost. Device-local.
function drawFailedOps(card, biz) {
  let log = [];
  try { log = JSON.parse(localStorage.getItem(LS.failed) || '[]'); } catch { /* corrupt → empty */ }
  // Orphans surface under every business (they need the owner to choose their books); a
  // business-stamped rejection shows only under its own business.
  const mine = log.filter(e => !e.biz || e.biz === biz);
  const orphans = mine.filter(e => !e.biz);
  const stamped = mine.filter(e => e.biz);
  const header = el('div', { class: 'cardtitle' }, `Held & rejected writes${mine.length ? ` (${mine.length})` : ''}`);
  if (!mine.length) {
    clear(card).append(header, el('p', { class: 'sub' }, 'None. If a write ever can’t be routed, or the server turns one down, it’s held here instead of being lost.'));
    return;
  }
  const fmtWhen = ts => { try { return new Date(ts).toLocaleString(); } catch { return '—'; } };
  const label = op => { const d = describeWrite(op); return d.kind === 'txn' ? `${d.date ? d.date + ' · ' : ''}${d.payee || '(no payee)'} · ${fmtMoney(d.cents)}` : d.fallback; };
  const businesses = getBusinesses();

  // An orphan needs the owner to say which books it belongs to — then it's filed exactly there.
  const orphanRow = (e) => {
    const bizName = id => businesses.find(b => b.id === id)?.name || id || 'unknown';
    // Layer 3: a wrong-business refusal carries the write's SEAL (the books that were open
    // when it was made) — pre-point the picker there and SAY so; the generic "no business
    // was set" copy would be false for it (a business WAS set; the server refused it).
    const sealed = e.op?._sealBiz || '';
    const sealedKnown = sealed && businesses.some(b => b.id === sealed);
    const refused = e.reason === 'wrong-business';
    const sel = el('select', { class: 'field-input', style: 'max-width:220px;margin:0' },
      el('option', { value: '' }, 'Choose its books…'),
      ...businesses.map(b => el('option', { value: b.id }, b.name || b.id)));
    if (sealedKnown) sel.value = sealed;
    const caption = refused
      ? (sealedKnown
        ? `${fmtWhen(e.rejectedAt)} · refused — headed for ${bizName(e.attempted)}’s books but made in ${bizName(sealed)}’s`
        : `${fmtWhen(e.rejectedAt)} · refused — headed for ${bizName(e.attempted)}’s books; made in “${sealed || '?'}”, which is no longer in your list. Pick where it belongs now.`)
      : `${fmtWhen(e.rejectedAt)} · held because no business was set`;
    return el('div', { class: 'card', style: 'border:1px solid var(--amber);margin:0 0 8px;box-shadow:none' },
      el('div', { style: 'font-weight:700;color:var(--amber);font-size:12px;margin-bottom:3px' },
        refused ? '⚠️ Refused — it was headed into the wrong books; choose where to file it' : '⚠️ Not saved yet — choose its books'),
      el('div', { style: 'font-weight:600' }, label(e.op)),
      el('div', { class: 'sub', style: 'margin:2px 0 8px' }, caption),
      el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, sel,
        el('button', { class: 'btn sm', onclick: async () => {
          const b = sel.value;
          if (!b) { toast('Choose a business first', 'err'); return; }
          // Remove THIS orphan from the log by identity (re-read live so a concurrent change
          // isn't clobbered), then file it to the chosen books.
          let cur = []; try { cur = JSON.parse(localStorage.getItem(LS.failed) || '[]'); } catch { /* empty */ }
          const os = JSON.stringify(e.op);
          const idx = cur.findIndex(x => !x.biz && x.rejectedAt === e.rejectedAt && JSON.stringify(x.op) === os);
          // Claim-then-file: only file if THIS click removed the orphan from the log. If it was
          // already filed (another tab, or a double-click), bail — filing it again would land the
          // same write in a SECOND company's books, the exact hole this fix exists to close.
          if (idx < 0) { toast('Already filed', 'err'); drawFailedOps(card, biz); return; }
          cur.splice(idx, 1); localStorage.setItem(LS.failed, JSON.stringify(cur));
          await saveOrphanTo(b, e.op);
          toast('Saved to ' + (businesses.find(x => x.id === b)?.name || b));
          drawFailedOps(card, biz);
        } }, 'Save to these books')));
  };

  const stampedTable = stamped.length ? el('div', { style: 'overflow-x:auto' }, el('table', { class: 'data xl' },
    el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Write'), el('th', {}, 'Reason'))),
    el('tbody', {}, ...stamped.map(e => el('tr', {},
      el('td', {}, fmtWhen(e.rejectedAt)),
      el('td', {}, label(e.op)),
      // 'wrong-business' appears here only via the mixed-version window (an old tab
      // dead-lettering a Layer-3 refusal as a stamped row) — say it in words.
      el('td', {}, e.reason === 'wrong-business' ? 'refused: made in a different company' : String(e.reason || 'rejected'))))))) : null;

  clear(card).append(
    header,
    el('p', { class: 'sub' }, 'Writes that couldn’t be routed, or that the server turned down — held so nothing is silently lost. A held write waits until you file it to the right books.'),
    ...orphans.map(orphanRow),
    stampedTable || el('span'),
    stamped.length ? el('div', { style: 'margin-top:12px' },
      el('button', { class: 'btn sm ghost', onclick: () => {
        if (!confirm(`Clear ${stamped.length} rejected-write log entr${stamped.length === 1 ? 'y' : 'ies'} for this business? This removes only the diagnostic log for writes the server rejected — un-saved writes are kept, and no books data changes.`)) return;
        let all = []; try { all = JSON.parse(localStorage.getItem(LS.failed) || '[]'); } catch { /* empty */ }
        const kept = all.filter(e => !e.biz || e.biz !== biz);   // keep orphans + other businesses
        localStorage.setItem(LS.failed, JSON.stringify(kept));
        toast('Cleared');
        drawFailedOps(card, biz);
      } }, 'Clear rejected log')) : el('span'));
}

// ── Business features (per-business modules) ──
// Stored on meta.features; absent flags derive from existing data (store.js), so
// existing businesses are correct before anyone opens this card. Hiding a module
// never deletes data — toggling it back on brings everything back.
function drawFeaturesCard(card) {
  const invoices = el('input', { type: 'checkbox', checked: usesInvoices() });
  const muse = el('input', { type: 'checkbox', checked: usesMuseSync() });
  const row = (input, label, help) => el('label', { style: 'display:flex;align-items:flex-start;gap:8px;margin-top:8px' },
    input, el('span', {}, el('b', {}, label), help ? el('div', { class: 'sub', style: 'margin:0;font-weight:400' }, help) : null));
  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Business features'),
    el('p', { class: 'sub' }, 'Turn modules on or off for this business. This only shows or hides screens — it never deletes data, so toggling a module back on brings everything back.'),
    row(invoices, 'Invoices / accounts receivable', 'Adds the Invoices tab for businesses that send invoices and track receivables.'),
    row(muse, 'Muse salon sync', 'Adds the Deposits tab and the salon-sync mapping. Only the Muse salon uses this.'),
    el('div', { style: 'margin-top:12px' },
      el('button', { class: 'btn sm', onclick: () => {
        const meta = getState().meta || {};
        dispatch({ op: 'meta.set', value: { ...meta, features: { ...(meta.features || {}), invoices: invoices.checked, museSync: muse.checked } } });
        toast('Business features saved');
      } }, 'Save')),
  );
}

// ── AI usage & controls ──
function drawAICard(card) {
  const month = new Date().toISOString().slice(0, 7);
  const usage = entities('aiusage');
  const monthRows = usage.filter(u => u.month === month);
  const monthMicros = monthRows.reduce((s, u) => s + (u.costMicros || 0), 0);
  const lifetimeMicros = usage.reduce((s, u) => s + (u.costMicros || 0), 0);
  const settings = byId('aisetting', 'ai') || { id: 'ai', monthlyBudgetCents: 0, paused: false };
  const budgetMicros = (settings.monthlyBudgetCents || 0) * 10000;

  const fmtMicros = (m) => '$' + (m / 1e6).toFixed(2);
  const budget = el('input', { class: 'field-input', style: 'max-width:140px;margin:0', placeholder: 'no cap', inputmode: 'decimal',
    value: settings.monthlyBudgetCents ? (settings.monthlyBudgetCents / 100).toFixed(2) : '' });
  const paused = el('input', { type: 'checkbox', checked: !!settings.paused });

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'AI usage & spending'),
    el('p', { class: 'sub' }, 'Every Claude call this business makes is metered here. The budget and pause switch are enforced on the server before any money is spent — the hard backstop is still the spend limit in your Anthropic Console.'),
    el('table', { class: 'data' },
      el('tr', {}, el('td', {}, 'This month'), el('td', { class: 'num' }, el('b', {}, fmtMicros(monthMicros))),
        el('td', { style: 'color:var(--mut)' }, `${monthRows.length} batch${monthRows.length === 1 ? '' : 'es'}${budgetMicros ? ` · budget ${fmtMicros(budgetMicros)}` : ''}`)),
      el('tr', {}, el('td', {}, 'All time'), el('td', { class: 'num' }, fmtMicros(lifetimeMicros)),
        el('td', { style: 'color:var(--mut)' }, `${usage.length} batch${usage.length === 1 ? '' : 'es'}`)),
    ),
    budgetMicros && monthMicros >= budgetMicros ? el('p', {}, el('span', { class: 'pill red' }, 'Monthly budget reached — AI is blocked until next month or a higher cap')) : el('span'),
    settings.paused ? el('p', {}, el('span', { class: 'pill amber' }, 'AI is paused')) : el('span'),
    el('div', { style: 'display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-top:10px' },
      el('div', {}, el('label', { class: 'field-label' }, 'Monthly budget ($, blank = no cap)'), budget),
      el('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:600;padding-bottom:9px' }, paused, ' Pause AI suggestions'),
      el('button', { class: 'btn sm', onclick: () => {
        const cents = budget.value.trim() === '' ? 0 : parseMoney(budget.value);
        if (cents === null || cents < 0) { toast('Budget should look like 5.00', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'aisetting', value: { ...settings, monthlyBudgetCents: cents, paused: paused.checked } });
        toast('AI settings saved');
      } }, 'Save')),
  );
}

// ── Muse sync mapping (M11) ──
// Where each synced salon row posts: the BALANCING side is fixed here per row
// type; the suggested CATEGORY is just the Review screen's preselect. Stored on
// meta.museMapping so it syncs to every device of this business.
function drawMuseCard(card, biz) {
  const meta = getState().meta || {};
  const mapping = meta.museMapping || { balancing: {}, category: {} };
  const accounts = entities('account').filter(a => a.active !== false);
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const acctSelect = (selected, hint) => el('select', { class: 'field-input', style: 'margin:0;min-width:180px' },
    el('option', { value: '' }, hint ? `— e.g. ${hint} —` : '—'),
    ...accounts
      .slice()
      .sort((a, b) => (a.type + accountLabel(a, accountsById)).localeCompare(b.type + accountLabel(b, accountsById)))
      .map(a => el('option', { value: a.id, selected: a.id === selected }, `${accountLabel(a, accountsById)} (${a.type})`)));

  const rows = [];
  const sels = {};
  for (const [type, t] of Object.entries(MUSE_SYNC_TYPES)) {
    const bal = acctSelect(mapping.balancing?.[type], t.balHint);
    const cat = acctSelect(mapping.category?.[type], t.catHint);
    sels[type] = { bal, cat };
    rows.push(el('tr', {},
      el('td', {}, el('b', {}, t.label), el('div', { class: 'sub', style: 'margin:0' }, t.dir === 'in' ? 'money in' : 'money out')),
      el('td', {}, bal), el('td', {}, cat)));
  }

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Muse sync — salon → books'),
    el('p', { class: 'sub' },
      'The salon app pushes its finalized daily numbers here; they wait on the Review screen and post only when you approve them. ',
      'Set where each row type lands: the balancing account is the other side of the entry, the category is what Review pre-picks. ',
      `Muse pushes to ${ORIGIN}/sync/inbound for business “${biz}” using the SYNC_TOKEN secret (set on this Worker and in Muse's Back Office sync card).`),
    el('div', { style: 'overflow-x:auto' },
      el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Salon row'), el('th', {}, 'Balancing account'), el('th', {}, 'Suggested category'))),
        el('tbody', {}, ...rows))),
    el('div', { style: 'margin-top:10px' },
      el('button', { class: 'btn sm', onclick: () => {
        const balancing = {}, category = {};
        for (const [type, s] of Object.entries(sels)) {
          if (s.bal.value) balancing[type] = s.bal.value;
          if (s.cat.value) category[type] = s.cat.value;
        }
        dispatch({ op: 'meta.set', value: { ...getState().meta, museMapping: { balancing, category } } });
        toast('Muse mapping saved');
      } }, 'Save mapping')),
  );
}

// ── QuickBooks Desktop export (M12) ──
// Writes an .iif of every POSTED txn in the range plus the full chart of
// accounts (QB auto-creates any account it's missing). Exported txns are
// stamped qbExportedAt so a later overlapping export warns — QB will happily
// import the same journal entries twice and double the books.
function drawQbCard(card, biz) {
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const today = new Date().toISOString().slice(0, 10);
  const from = el('input', { class: 'field-input', type: 'date', style: 'margin:0;max-width:170px', value: monthStart });
  const to = el('input', { class: 'field-input', type: 'date', style: 'margin:0;max-width:170px', value: today });
  const result = el('p', { class: 'sub', style: 'margin-top:8px' });

  const doExport = () => {
    if (!from.value || !to.value || from.value > to.value) { toast('Pick a valid date range', 'err'); return; }
    const accounts = entities('account');
    const { text, count, txns } = buildIif({ accounts: accounts.filter(a => a.active !== false), txns: entities('txn'), from: from.value, to: to.value });
    if (!count) { toast('No posted transactions in that range', 'err'); return; }
    const already = txns.filter(t => t.qbExportedAt).length;
    if (already && !confirm(`${already} of these ${count} transactions were exported before — importing them into QuickBooks again will double them there. Export anyway?`)) return;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `backoffice-${biz}-${from.value}-to-${to.value}.iif`;
    a.click();
    URL.revokeObjectURL(a.href);

    const now = Date.now();
    const stamped = txns.map(t => ({ ...t, qbExportedAt: now, updatedAt: now }));
    for (let i = 0; i < stamped.length; i += 400) {
      dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: stamped.slice(i, i + 400) });
    }
    result.textContent = `Exported ${count} transactions (${already} re-exports). In QuickBooks Desktop: File → Utilities → Import → IIF Files.`;
    toast(`Exported ${count} transactions to .iif`);
  };

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'QuickBooks Desktop export'),
    el('p', { class: 'sub' }, 'Download an .iif file of the posted ledger for a date range, including the chart of accounts. Already-exported transactions trigger a duplicate warning.'),
    el('div', { style: 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap' },
      el('div', {}, el('label', { class: 'field-label' }, 'From'), from),
      el('div', {}, el('label', { class: 'field-label' }, 'To'), to),
      el('button', { class: 'btn sm', onclick: doExport }, 'Export .iif')),
    result,
  );
}

// ── Sync the chart of accounts + vendor list TO QuickBooks Desktop (one-way) ──
// The app is the source of truth. The .iif holds every ACTIVE account + vendor; QB
// matches by name, so importing it creates the new ones and updates fields on the rest
// (never a duplicate). Renames / merges / archives can't ride in an IIF, so they're
// shown as a manual checklist, computed by diffing the current state against the last
// synced snapshot (meta.qbSync). "Mark as synced" rewrites that snapshot.
function drawQbListSyncCard(card, biz) {
  const accounts = entities('account');
  const vendors = entities('vendor');
  const baseline = getState().meta?.qbSync || null;
  const diff = qbSyncDiff(baseline, accounts, vendors);
  const counts = qbSyncCounts(diff);
  const lastAt = getState().meta?.qbSync?.at;
  const activeAccounts = accounts.filter(a => a.active !== false);
  const activeVendors = vendors.filter(v => v.active !== false);

  const download = () => {
    const { text, accounts: na, vendors: nv } = buildListsIif({ accounts: activeAccounts, vendors: activeVendors });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `backoffice-${biz}-lists.iif`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Downloaded ${na} accounts + ${nv} vendors. In QuickBooks Desktop: File → Utilities → Import → IIF Files.`);
  };

  const markSynced = () => {
    if (!confirm('Mark as synced? Do this only AFTER you’ve imported the file and applied the manual steps in QuickBooks. It records the current accounts & vendors as the new baseline, so next time only later changes show.')) return;
    const snap = qbSyncSnapshot(accounts, vendors);
    dispatch({ op: 'meta.set', value: { ...getState().meta, qbSync: { ...snap, at: Date.now() } } });
    toast('Marked as synced — QuickBooks and the app are in step.');
  };

  const steps = [];
  for (const r of diff.accounts.renames) steps.push(`Rename account “${r.from}” → “${r.to}”`);
  for (const m of diff.accounts.merges) steps.push(`Merge account “${m.from}” into “${m.into}” (in QB, rename “${m.from}” to “${m.into}” — QB then merges them)`);
  for (const a of diff.accounts.archives) steps.push(`Make account “${a}” inactive`);
  for (const t of diff.accounts.typeChanges) steps.push(`Account “${t.name}” changed type (${t.from} → ${t.to}) — may need manual reassignment in QB`);
  for (const r of diff.vendors.renames) steps.push(`Rename vendor “${r.from}” → “${r.to}”`);
  for (const v of diff.vendors.removed) steps.push(`Vendor “${v}” was merged/removed in the app — make it inactive in QB (or merge it)`);

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Sync lists to QuickBooks'),
    el('p', { class: 'sub' }, 'Push your chart of accounts and vendor list to QuickBooks Desktop so it matches the app (the app is the source of truth). The file creates anything new and updates existing names/types automatically. Renames, merges, and archives can’t go through a file — apply those by hand using the checklist.'),
    diff.firstSync
      ? el('p', {}, el('b', {}, 'First sync'), ` — the file will create all ${activeAccounts.length} accounts and ${activeVendors.length} vendors in QuickBooks. No manual steps.`)
      : el('p', {}, counts.creates
          ? `${counts.creates} new item${counts.creates === 1 ? '' : 's'} will be created by the file.`
          : 'No new accounts or vendors since the last sync.',
        lastAt ? el('span', { class: 'sub' }, ` · last synced ${new Date(lastAt).toLocaleDateString()}`) : ''),
    steps.length
      ? el('div', { style: 'margin:10px 0' },
          el('div', { class: 'field-label', style: 'color:var(--red)' }, `Apply by hand in QuickBooks (${steps.length})`),
          el('ul', { style: 'margin:4px 0 0;padding-left:20px;font-size:13px;line-height:1.7' }, ...steps.map(s => el('li', {}, s))))
      : (diff.firstSync ? el('span') : el('p', { class: 'sub', style: 'color:var(--green)' }, 'Nothing to apply by hand — no renames, merges, or archives since the last sync.')),
    el('div', { style: 'display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:8px' },
      el('button', { class: 'btn sm', onclick: download }, 'Download list file (.iif)'),
      el('button', { class: 'btn sm ghost', onclick: markSynced }, 'Mark as synced')),
  );
}

// ── Import the chart of accounts from a QuickBooks .IIF export ──
// Reads only the !ACCNT section (see lib/qb-iif-import.js). Matches by full
// account path so an account that already exists is skipped, never duplicated;
// QB subaccounts (Parent:Child) keep their parent link. Accounts only — never
// transactions. CCARD accounts import as transfer-capable (qbType CCARD).
function drawQbImportCard(card, biz) {
  // existing accounts keyed by their full "parent:child" path (lowercased)
  const idTo = new Map(entities('account').map(a => [a.id, a]));
  const pathOf = (a) => {
    const parts = [a.name]; let cur = a, hops = 0;
    while (cur.parentId && hops++ < 5) { cur = idTo.get(cur.parentId); if (!cur) break; parts.unshift(cur.name); }
    return parts.join(':').toLowerCase();
  };
  const existingByPath = new Map(entities('account').map(a => [pathOf(a), a]));

  const file = el('input', { type: 'file', accept: '.iif,.txt', class: 'field-input', style: 'max-width:340px' });
  const preview = el('div', { style: 'margin-top:10px' });
  const importBtn = el('button', { class: 'btn sm', disabled: true }, 'Import accounts');
  let toCreate = []; // [{ name, parentName, type, qbType, qbName }]

  const uniqueId = (name, taken) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'account';
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  };

  file.addEventListener('change', async () => {
    toCreate = []; importBtn.disabled = true; clear(preview);
    const f = file.files?.[0];
    if (!f) return;
    let parsed;
    try { parsed = parseIifAccounts(await f.text()); }
    catch { preview.append(el('p', { class: 'sub' }, 'Could not read that file.')); return; }

    const exists = [];
    for (const a of parsed.accounts) {
      if (existingByPath.has(a.qbName.toLowerCase())) exists.push(a);
      else toCreate.push(a);
    }
    const unsupported = parsed.skipped;
    if (!parsed.accounts.length && !unsupported.length) {
      preview.append(el('p', { class: 'sub' }, 'No accounts found in that file. Export from QuickBooks via File → Utilities → Export → Lists to IIF Files (Chart of Accounts).'));
      return;
    }
    preview.append(
      el('p', {}, el('b', {}, `${toCreate.length} new`), ` to import · ${exists.length} already exist (skipped)`,
        unsupported.length ? ` · ${unsupported.length} unsupported (skipped)` : ''),
      toCreate.length ? el('div', { class: 'sub', style: 'max-height:150px;overflow:auto;margin-top:4px' },
        ...toCreate.slice(0, 60).map(a => el('div', {}, `${a.qbName} — ${a.type}`)),
        toCreate.length > 60 ? el('div', {}, `…and ${toCreate.length - 60} more`) : '') : el('span'),
    );
    importBtn.disabled = !toCreate.length;
  });

  importBtn.addEventListener('click', () => {
    if (!toCreate.length) return;
    const taken = new Set(entities('account').map(a => a.id));
    const createdByPath = new Map(); // lowercased path → new account (for parent links)
    const values = [];
    for (const a of toCreate) {
      const id = uniqueId(a.name, taken);
      taken.add(id);
      let parentId = null;
      if (a.parentName) {
        const key = a.parentName.toLowerCase();
        const parent = existingByPath.get(key) || createdByPath.get(key);
        if (parent) parentId = parent.id;
      }
      const acct = { id, name: a.name, type: a.type, qbType: a.qbType, qbName: a.qbName.split(':').pop(), parentId, active: true };
      values.push(acct);
      createdByPath.set(a.qbName.toLowerCase(), acct);
    }
    for (let i = 0; i < values.length; i += 200) {
      dispatch({ op: 'entity.bulkUpsert', kind: 'account', values: values.slice(i, i + 200) });
    }
    toast(`Imported ${values.length} account${values.length === 1 ? '' : 's'}`);
    clear(preview).append(el('p', { class: 'sub' }, `Imported ${values.length} accounts. They’re now in your chart of accounts and category pickers.`));
    importBtn.disabled = true; toCreate = []; file.value = '';
  });

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Import chart of accounts (.IIF)'),
    el('p', { class: 'sub' }, 'Bring a client’s QuickBooks Desktop accounts in. In QuickBooks: File → Utilities → Export → Lists to IIF Files → Chart of Accounts. Accounts that already exist are skipped, so re-importing is safe. Transactions are not imported.'),
    file, importBtn, preview,
  );
}

// ── Import QuickBooks transaction history (reconstructed bundle) ──
// One-time historical import: a JSON bundle reconstructed offline from a QuickBooks
// "Transaction Detail by Account" export (chart of accounts + posted double-entry
// transactions). Creates accounts + bank accounts, posts the transactions, pre-marks
// QB-cleared ones reconciled, and tags expenses to invoices by their "Inv. ####" memo.
// Deterministic ids → re-importing merges instead of duplicating.
function drawQbHistoryCard(card, biz) {
  const file = el('input', { type: 'file', accept: '.json', class: 'field-input', style: 'max-width:340px' });
  const preview = el('div', { style: 'margin-top:10px' });
  const importBtn = el('button', { class: 'btn sm', disabled: true }, 'Import history');
  let built = null;

  const money = (c) => fmtMoney(c);
  file.addEventListener('change', async () => {
    built = null; importBtn.disabled = true; clear(preview);
    const f = file.files?.[0]; if (!f) return;
    let bundle;
    try { bundle = JSON.parse(await f.text()); }
    catch { preview.append(el('p', { class: 'sub' }, 'Could not read that file — expected the reconstructed qb-import.json.')); return; }
    built = buildQbImport(bundle, {
      existingAccounts: entities('account'), existingBankaccts: entities('bankacct'),
      existingInvoices: entities('invoice'), now: Date.now(),
    });
    if (built.errors?.length && !built.transactions) { preview.append(el('p', { style: 'color:var(--red)' }, built.errors[0])); return; }
    const p = built.preview;
    const unmatched = p.unmatchedInvoices;
    preview.append(
      el('p', {}, el('b', {}, `${p.totalTxns} transactions`), ` ready`, p.skipped ? ` · ${p.skipped} skipped (see below)` : '',
        ` · ${p.newAccounts} new accounts (${p.existingAccounts} exist)`, ` · ${p.newBankaccts} bank accounts`),
      el('p', { class: 'sub', style: 'margin:2px 0' }, `${p.reconciledTxns} will be marked reconciled · ${p.taggedInvoices} expenses tagged to invoices${unmatched.length ? ` · ${unmatched.length} invoice #s not found` : ''}`),
      el('div', { style: 'margin:8px 0' }, el('div', { class: 'cardtitle', style: 'font-size:12px' }, 'Bank/credit-card balances (compare to QuickBooks)'),
        el('table', { class: 'data xl' }, el('thead', {}, el('tr', {}, el('th', {}, 'Account'), el('th', { class: 'num' }, 'Computed balance'))),
          el('tbody', {}, ...p.moneyBalances.map(m => el('tr', {}, el('td', {}, m.name), el('td', { class: 'num' }, acctAmount(m.cents, { colored: false })))))) ),
      unmatched.length ? el('details', { style: 'margin-top:6px' },
        el('summary', { class: 'sub', style: 'cursor:pointer' }, `${unmatched.length} referenced invoice #s aren’t imported yet (memo kept; tag later)`),
        el('div', { class: 'sub', style: 'max-height:120px;overflow:auto' }, unmatched.map(u => `#${u.number}×${u.count}`).join(', '))) : el('span'),
      built.errors?.length ? el('details', { style: 'margin-top:6px' },
        el('summary', { class: 'sub', style: 'cursor:pointer;color:var(--amber)' }, `${built.errors.length} transactions skipped (validation)`),
        el('div', { class: 'sub', style: 'max-height:120px;overflow:auto' }, ...built.errors.slice(0, 40).map(e => el('div', {}, e)))) : el('span'),
    );
    importBtn.disabled = !p.totalTxns;
  });

  importBtn.addEventListener('click', () => {
    if (!built?.transactions?.length) return;
    importBtn.disabled = true;
    const meta = getState().meta || {};
    dispatch({ op: 'meta.set', value: { ...meta, features: { ...(meta.features || {}), invoices: true } } });
    const chunk = (kind, arr) => { for (let i = 0; i < arr.length; i += 200) dispatch({ op: 'entity.bulkUpsert', kind, values: arr.slice(i, i + 200) }); };
    if (built.accountsToAdd.length) chunk('account', built.accountsToAdd);
    for (const b of built.bankaccts) dispatch({ op: 'entity.upsert', kind: 'bankacct', value: b });
    chunk('txn', built.transactions);
    for (const r of built.recons) dispatch({ op: 'entity.upsert', kind: 'recon', value: r });
    const p = built.preview;
    toast(`Imported ${p.totalTxns} transactions`);
    clear(preview).append(el('p', { class: 'sub' }, `Imported ${p.totalTxns} transactions, ${built.accountsToAdd.length} accounts, ${built.bankaccts.length} bank accounts. ${p.reconciledTxns} marked reconciled. Reconcile the open periods against your statements; recognize income via Invoice2go → Post payments (set its clearing account to “Undeposited Funds”).`));
    file.value = ''; built = null;
  });

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Import QuickBooks transaction history'),
    el('p', { class: 'sub' }, 'One-time historical import from a QuickBooks “Transaction Detail by Account” export (reconstructed to qb-import.json). Posts every bank/credit-card transaction, pre-marks the QB-cleared ones reconciled, and tags expenses to invoices by their “Inv. ####” memo. Bank balances match QuickBooks to the penny; income stays in Undeposited/clearing for Invoice2go to recognize. Safe to re-run.'),
    file, importBtn, preview,
  );
}

// ── Close the books (period locks) ──
// A locked month rejects new postings and edits to posted entries in that month
// — enforced on every device (validateTxn) AND on the server (BusinessDO). Metadata
// fixes and QB re-exports still pass; unlock anytime. Lock entity id = 'YYYY-MM'.
function drawLocksCard(card) {
  const locks = entities('lock').slice().sort((a, b) => a.id < b.id ? 1 : -1);
  const month = el('input', { class: 'field-input', type: 'month', style: 'margin:0;max-width:170px' });

  const list = locks.length
    ? el('table', { class: 'data xl' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Closed month'), el('th', {}, 'Locked on'), el('th', {}, ''))),
        el('tbody', {}, ...locks.map(l => el('tr', {},
          el('td', {}, l.id),
          el('td', { style: 'color:var(--mut)' }, l.closedAt ? new Date(l.closedAt).toLocaleDateString() : '—'),
          el('td', {}, el('button', { class: 'btn sm ghost', onclick: () => {
            if (!confirm(`Reopen ${l.id}? Postings and edits in that month will be allowed again until you close it.`)) return;
            dispatch({ op: 'entity.delete', kind: 'lock', id: l.id });
            toast(`${l.id} reopened`);
          } }, 'Reopen')))))
      )
    : el('p', { class: 'sub' }, 'No months are closed.');

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Close the books'),
    el('p', { class: 'sub' }, 'Lock a finished month so its posted transactions can’t be changed or added to by mistake — enforced on every device and on the server. QuickBooks re-exports of a closed month still work; reopen a month anytime you need to make changes.'),
    list,
    el('div', { style: 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:12px' },
      el('div', {}, el('label', { class: 'field-label' }, 'Month to close'), month),
      el('button', { class: 'btn sm', onclick: () => {
        const p = month.value;
        if (!/^\d{4}-\d{2}$/.test(p)) { toast('Pick a month to close', 'err'); return; }
        if (entities('lock').some(l => l.id === p)) { toast(`${p} is already closed`); return; }
        const now = Date.now();
        dispatch({ op: 'entity.upsert', kind: 'lock', value: { id: p, closedAt: now, updatedAt: now } });
        toast(`${p} closed`);
        month.value = '';
      } }, 'Close month')),
  );
}

async function drawUsers(card, biz) {
  clear(card).append(el('div', { class: 'cardtitle' }, 'Users'));
  const me = getUser()?.id;
  const refresh = () => drawUsers(card, biz);
  try {
    const { users } = await (await api(`/registry/users?businessId=${biz}`)).json();
    if (!users.length) card.append(el('p', { class: 'sub' }, 'No users yet — the owner account always has access.'));
    for (const u of users) {
      const actions = u.id === me
        ? [el('span', { class: 'sub', style: 'margin:0' }, 'you')]
        : [el('button', { class: 'btn sm ghost', onclick: () => editUserModal(u, biz, refresh) }, 'Edit'),
           el('button', { class: 'btn sm ghost', style: 'color:var(--red)', onclick: () => removeUser(u, biz, refresh) }, 'Remove')];
      card.append(el('div', { class: 'rowline', style: 'display:flex;align-items:center;gap:10px' },
        el('b', {}, u.name),
        el('span', { class: 'sub', style: 'margin:0;flex:1' }, `${u.identifier} · ${u.role}`),
        ...actions));
    }
  } catch { card.append(el('p', { class: 'sub' }, 'Could not load users.')); }

  const name = el('input', { class: 'field-input', placeholder: 'Name' });
  const ident = el('input', { class: 'field-input', placeholder: 'Login name' });
  const pin = el('input', { class: 'field-input', placeholder: 'PIN (4–8 digits)', inputmode: 'numeric' });
  const role = el('select', { class: 'field-input' }, ...ROLES.map(r => el('option', { value: r, selected: r === 'bookkeeper' }, `${r} — ${ROLE_HELP[r]}`)));
  card.append(el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const res = await api('/registry/users', {
      method: 'POST',
      body: JSON.stringify({ businessId: biz, name: name.value.trim(), identifier: ident.value, pin: pin.value, role: role.value }),
    });
    if (res.ok) { toast('User added'); drawUsers(card, biz); }
    else toast((await res.json()).error === 'identifier taken' ? 'That login name is taken' : 'Check the fields', 'err');
  } },
    el('div', { class: 'cardtitle', style: 'margin-top:14px' }, 'Add user'),
    name, ident, pin, role,
    el('button', { class: 'btn', type: 'submit' }, 'Add user'),
  ));
}

// Edit a member: rename, change role, and/or reset their PIN. Each is a separate Worker
// call; a blank PIN leaves it unchanged. (The owner account can't be edited here — it
// never appears in the members list.)
function editUserModal(u, biz, refresh) {
  const m = modal(`Edit ${u.name}`);
  const name = el('input', { class: 'field-input', value: u.name || '' });
  const role = el('select', { class: 'field-input' }, ...ROLES.map(r => el('option', { value: r, selected: r === u.role }, `${r} — ${ROLE_HELP[r]}`)));
  const pin = el('input', { class: 'field-input', placeholder: 'New PIN (leave blank to keep)', inputmode: 'numeric' });
  m.body.append(
    el('label', { class: 'field-label' }, 'Name'), name,
    el('label', { class: 'field-label' }, 'Role'), role,
    el('label', { class: 'field-label' }, 'Reset PIN'), pin,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: async () => {
        try {
          const r = await api('/registry/users/update', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: u.id, name: name.value.trim(), role: role.value }) });
          if (!r.ok) throw new Error('update');
          if (pin.value.trim()) {
            const rp = await api('/registry/users/resetpin', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: u.id, pin: pin.value.trim() }) });
            if (!rp.ok) { toast('Saved, but the PIN reset failed — use 4–8 digits', 'err'); m.close(); refresh(); return; }
          }
          toast('User updated'); m.close(); refresh();
        } catch { toast('Could not update — check your role or reload', 'err'); }
      } }, 'Save')));
}

async function removeUser(u, biz, refresh) {
  if (!confirm(`Remove ${u.name} (${u.identifier}) from this business? They lose access right away. If they belong to no other business, their login is deleted.`)) return;
  try {
    const r = await api('/registry/users/delete', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: u.id }) });
    if (!r.ok) throw new Error('delete');
    toast('User removed'); refresh();
  } catch { toast('Could not remove — check your role or reload', 'err'); }
}

async function drawDevices(card, biz) {
  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Signed-in devices'),
    el('p', { class: 'sub' }, 'Devices people have signed in on with their PIN — no approval is needed, any valid PIN signs in. Sign one out to end its session (handy for a lost or shared device); they can sign back in with their PIN. To remove someone for good, remove them under Users above.'));
  try {
    const { devices } = await (await api(`/registry/devices?businessId=${biz}`)).json();
    if (!devices.length) { card.append(el('p', { class: 'sub' }, 'No devices signed in yet.')); return; }
    for (const d of devices) {
      const line = el('div', { class: 'rowline' },
        el('b', {}, d.userName), el('span', { class: 'sub', style: 'margin:0' }, ` ${d.name || d.deviceId}`));
      line.append(el('button', { class: 'btn sm ghost', style: 'margin-left:10px', onclick: async () => {
        if (!confirm(`Sign out ${d.userName}’s device “${d.name || d.deviceId}”? It’ll be signed out and they’ll need to sign in again with their PIN.`)) return;
        const res = await api('/registry/devices/revoke', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: d.userId, deviceId: d.deviceId }) });
        if (res.ok) { toast('Device signed out'); drawDevices(card, biz); }
        else toast('Could not sign out device — check your role or reload', 'err');
      } }, 'Sign out'));
      card.append(line);
    }
  } catch { card.append(el('p', { class: 'sub' }, 'Could not load devices.')); }
}
