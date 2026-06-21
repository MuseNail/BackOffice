// ── view: reconcile — tie a bank account to its statement, to the penny ────────────────
// Check off what appears on the statement. Cleared total must equal the
// statement's ending balance before Close enables. Closing stamps each cleared
// txn with reconciledIn (it leaves the uncleared list forever) and records a
// recon entity for the audit trail.
import { el, clear, toast, modal, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { parseMoney } from '../lib/money.js';
import { dateControl } from '../daterange.js';
import { logAudit } from '../audit.js';

let unsub = null;
let s = null; // { bankacctId, endDate, stmtCents, checked:Set }

export function render(root) {
  const first = entities('bankacct')[0];
  s = { bankacctId: first?.id || '', endDate: new Date().toISOString().slice(0, 10), stmtCents: null, checked: new Set() };
  const body = el('div');
  root.append(
    el('h2', {}, 'Reconcile'),
    el('p', { class: 'sub' }, 'Check off what appears on the bank statement. The difference must reach $0.00 to close — that’s the whole point.'),
    body,
  );
  const draw = () => drawBody(body);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; s = null; }

const bankLineCents = (txn, accountId) =>
  txn.lines.filter(l => l.accountId === accountId).reduce((sum, l) => sum + l.amountCents, 0);

function drawBody(body) {
  const editable = canEdit(getActiveBiz());
  const bankaccts = entities('bankacct');
  if (!bankaccts.length) {
    clear(body).append(el('p', { class: 'sub' }, 'Add a bank account in Banking first.'));
    return;
  }
  if (!bankaccts.find(b => b.id === s.bankacctId)) s.bankacctId = bankaccts[0].id;
  const bankacct = bankaccts.find(b => b.id === s.bankacctId);

  const acctSel = el('select', { class: 'field-input', style: 'max-width:240px;margin-bottom:0', onchange: (e) => { s.bankacctId = e.target.value; s.checked = new Set(); drawBody(body); } },
    ...bankaccts.map(b => el('option', { value: b.id, selected: b.id === s.bankacctId }, b.name)));
  // Statement end date — the Muse-style day picker, with month-end quick presets
  // (statements almost always close at a month end).
  const isoD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const endDateGroup = dateControl({ value: s.endDate, onPick: (iso) => { s.endDate = iso; drawBody(body); }, presets: [
    { label: 'End of this month', date: isoD(new Date(now.getFullYear(), now.getMonth() + 1, 0)) },
    { label: 'End of last month', date: isoD(new Date(now.getFullYear(), now.getMonth(), 0)) },
    { label: 'Today', date: isoD(now) },
  ] }).el;
  const balIn = el('input', { class: 'field-input', placeholder: 'Statement ending balance', style: 'max-width:220px;margin-bottom:0', inputmode: 'decimal',
    value: s.stmtCents == null ? '' : (s.stmtCents / 100).toFixed(2),
    onchange: (e) => { s.stmtCents = parseMoney(e.target.value); drawBody(body); } });

  const txns = entities('txn').filter(t => t.status === 'posted');
  // Bound to endDate: a future reconciliation shouldn't inflate this period's cleared balance.
  const alreadyCents = txns.filter(t => t.reconciledIn && t.date <= s.endDate).reduce((sum, t) => sum + bankLineCents(t, bankacct.accountId), 0);
  const candidates = txns
    .filter(t => !t.reconciledIn && t.date <= s.endDate && t.lines.some(l => l.accountId === bankacct.accountId))
    .sort((a, b) => a.date.localeCompare(b.date));
  s.checked = new Set([...s.checked].filter(id => candidates.some(t => t.id === id)));

  const checkedCents = candidates.filter(t => s.checked.has(t.id)).reduce((sum, t) => sum + bankLineCents(t, bankacct.accountId), 0);
  // Per-column running subtotals of the CHECKED items, so each side can be tied to the
  // statement's payments / deposits totals. Payments are money out (negative bank line).
  let checkedPayments = 0, checkedDeposits = 0;
  for (const t of candidates) {
    if (!s.checked.has(t.id)) continue;
    const c = bankLineCents(t, bankacct.accountId);
    if (c < 0) checkedPayments += -c; else checkedDeposits += c;
  }
  const clearedCents = alreadyCents + checkedCents;
  const diff = s.stmtCents == null ? null : s.stmtCents - clearedCents;
  const balanced = diff === 0;

  const rows = candidates.map(t => {
    const cents = bankLineCents(t, bankacct.accountId);
    const box = el('input', { type: 'checkbox', checked: s.checked.has(t.id), onchange: (e) => {
      e.target.checked ? s.checked.add(t.id) : s.checked.delete(t.id);
      drawBody(body);
    } });
    return el('tr', {},
      el('td', {}, editable ? box : ''),
      el('td', {}, t.date),
      el('td', {}, t.payee || t.memo || '—'),
      el('td', { class: 'num' }, cents < 0 ? fmtMoney(-cents) : ''),
      el('td', { class: 'num' }, cents > 0 ? fmtMoney(cents) : ''));
  });

  const history = entities('recon')
    .filter(r => r.bankacctId === bankacct.id)
    .sort((a, b) => b.statementEndDate.localeCompare(a.statementEndDate));

  clear(body).append(
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px' },
      labeled('Account', acctSel), labeled('Statement end date', endDateGroup), labeled('Ending balance', balIn)),
    el('div', { class: 'row', style: 'margin-bottom:14px' },
      kpi('Statement balance', s.stmtCents == null ? '—' : fmtMoney(s.stmtCents)),
      kpi('Cleared so far', fmtMoney(clearedCents), alreadyCents ? `${fmtMoney(alreadyCents)} from past reconciliations` : ''),
      el('div', { class: 'card', style: 'flex:1;min-width:190px' + (balanced ? ';border-color:var(--green);background:var(--green-soft)' : '') },
        el('div', { class: 'kpilbl' }, 'Difference'),
        el('div', { class: 'kpi', style: balanced ? 'color:var(--green)' : diff != null ? 'color:var(--red)' : '' }, diff == null ? 'enter the balance' : fmtMoney(diff)),
        (editable && balanced && s.checked.size) ? el('button', { class: 'btn sm green', onclick: () => confirmClose(bankacct, body) }, 'Close & lock these in') : el('span'))),
    candidates.length
      ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:800px' },
          el('table', { class: 'data' },
            el('tr', {}, el('th', {}, ''), el('th', {}, 'Date'), el('th', {}, 'Payee'), el('th', { class: 'num' }, 'Payments'), el('th', { class: 'num' }, 'Deposits')),
            ...rows,
            el('tr', { style: 'background:var(--brand-soft)' },
              el('td', { colspan: '3' }, el('b', {}, `${s.checked.size} checked`)),
              el('td', { class: 'num' }, el('b', {}, checkedPayments ? fmtMoney(checkedPayments) : '—')),
              el('td', { class: 'num' }, el('b', {}, checkedDeposits ? fmtMoney(checkedDeposits) : '—')))))
      : el('p', { class: 'sub' }, 'Nothing left to reconcile on or before that date — all caught up.'),
    history.length ? el('div', { class: 'card', style: 'max-width:760px' },
      el('div', { class: 'cardtitle' }, 'Past reconciliations'),
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'Statement date'), el('th', { class: 'num' }, 'Ending balance'), el('th', { class: 'num' }, 'Items')),
        ...history.map(r => el('tr', {},
          el('td', {}, r.statementEndDate),
          el('td', { class: 'num' }, fmtMoney(r.statementBalanceCents)),
          el('td', { class: 'num' }, String(r.clearedTxnIds.length)))))) : el('span'),
  );
}

function confirmClose(bankacct, body) {
  const m = modal('Close this reconciliation?');
  // Re-check for concurrent reconciliation before dispatching (RECON-003).
  const alreadyRecon = [...s.checked].filter(id => entities('txn').find(t => t.id === id)?.reconciledIn);
  m.body.append(
    alreadyRecon.length ? el('p', { style: 'color:var(--red)' }, `⚠️ ${alreadyRecon.length} of the checked transactions were already reconciled by another session. Reload to see the current state.`) : el('span'),
    el('p', {}, `${s.checked.size} transaction${s.checked.size === 1 ? '' : 's'} will be marked as reconciled through ${s.endDate}. Reconciled entries cannot be voided or deleted — they leave this screen for good.`),
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Not yet'),
      el('button', { class: 'btn green', disabled: alreadyRecon.length > 0, onclick: () => {
        const reconId = 'rec-' + Date.now().toString(36);
        dispatch({ op: 'entity.upsert', kind: 'recon', value: {
          id: reconId, bankacctId: bankacct.id, statementEndDate: s.endDate,
          statementBalanceCents: s.stmtCents, clearedTxnIds: [...s.checked], closedAt: Date.now(),
        } });
        for (const id of s.checked) {
          const t = entities('txn').find(x => x.id === id);
          if (t) dispatch({ op: 'entity.upsert', kind: 'txn', value: { ...t, reconciledIn: reconId } });
        }
        logAudit('reconcile', { summary: `Reconciled ${bankacct.name} through ${s.endDate} — ${s.checked.size} item${s.checked.size === 1 ? '' : 's'}, ending ${fmtMoney(s.stmtCents)}`, kind: 'recon', entityId: reconId, amountCents: s.stmtCents });
        s.checked = new Set();
        toast(`Reconciled to the penny — ${s.endDate} closed`);
        m.close();
        drawBody(body);
      } }, alreadyRecon.length ? 'Fix conflicts first' : 'Close it')),
  );
}

const labeled = (label, node) => el('div', {}, el('label', { class: 'field-label' }, label), node);
const kpi = (label, value, note = '') => el('div', { class: 'card', style: 'flex:1;min-width:190px' },
  el('div', { class: 'kpilbl' }, label), el('div', { class: 'kpi' }, value),
  note ? el('div', { class: 'sub', style: 'margin:0' }, note) : el('span'));
