// ── view: deposits — prove Muse recorded card = Helcim processed, per day ──────
// Phase 2 (read-only): for a date range, compare what Muse RECORDED as card money
// (sales_card + gift_sold, from the synced staged rows — pending OR approved)
// against what Helcim GROSS-processed that day (the card-transactions API, grouped
// by day via helcimDayTotals). With Fee Saver the customer pays bill + surcharge:
// Muse records the bill, Helcim's gross ≈ bill + surcharge, the bank deposit ≈
// bill. So a correct day shows Helcim a little ABOVE Muse by the surcharge. The
// typical surcharge is LEARNED from the overlapping days (no configured rate);
// days that don't fit get flagged. Owner/manager only.
// Deposit↔batch matching + posting the fee is Phase 3 — nothing here writes.

import { el, clear, fmtMoney } from '../ui.js';
import { todayLocal } from '../lib/day.js';
import { entities, subscribe, usesMuseSync } from '../store.js';
import { api } from '../sync.js';
import { getActiveBiz, roleFor } from '../session.js';
import { helcimDayTotals } from '../lib/processor-match.js';
import { summarizeDeposits } from '../lib/deposits-compare.js';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoStr, n) => { const d = new Date(isoStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

let unsub = null;
let s = null; // { from, to, helcim, helcimState, fetchSeq }

export function render(root) {
  const role = roleFor(getActiveBiz());
  if (role !== 'owner' && role !== 'manager') {
    root.append(
      el('h2', {}, 'Deposits'),
      el('p', { class: 'sub' }, 'Deposits reconciliation is available to owners and managers.'));
    return;
  }
  if (!usesMuseSync()) {
    root.append(
      el('h2', {}, 'Deposits'),
      el('p', { class: 'sub' }, 'The Deposits report compares Muse salon card sales with Helcim payouts — it’s only for the salon. This business isn’t set up for Muse salon sync.'));
    // Re-render if Muse sync gets enabled (async snapshot load / Settings toggle).
    unsub = subscribe(() => { if (usesMuseSync()) { unsub?.(); unsub = null; root.replaceChildren(); render(root); } });
    return;
  }
  const today = todayLocal();   // the owner's local day, not the UTC one (evening PST would read tomorrow)
  s = { from: addDays(today, -13), to: today, helcim: null, helcimState: 'idle', fetchSeq: 0 };
  const body = el('div');
  root.append(
    el('h2', {}, 'Deposits'),
    el('p', { class: 'sub' }, 'For each day: what Muse recorded as card money (card sales + gift cards sold) vs what Helcim actually processed. With Fee Saver, Helcim runs a little above Muse by the customer surcharge — the typical surcharge is learned from your own data, and any day that doesn’t fit is flagged.'),
    body);
  unsub = subscribe(() => drawBody(body));
  loadHelcim(body);
  drawBody(body);
}

export function unmount() { unsub?.(); unsub = null; s = null; }

// Pull Helcim card-transactions for the range; tolerate either a bare array or the
// Helcim { value:[…] } envelope. A fetchSeq guards against a stale range's response
// landing after a newer one.
async function loadHelcim(body) {
  const seq = ++s.fetchSeq;
  s.helcimState = 'loading';
  drawBody(body);
  try {
    const res = await api(`/b/${getActiveBiz()}/processor/helcim/transactions?dateFrom=${s.from}&dateTo=${s.to}`);
    if (seq !== s.fetchSeq) return;
    if (res.status === 501) { s.helcim = []; s.helcimState = 'unconfigured'; drawBody(body); return; }
    if (!res.ok) { s.helcim = []; s.helcimState = 'error'; drawBody(body); return; }
    const j = await res.json();
    s.helcim = Array.isArray(j) ? j : (Array.isArray(j?.value) ? j.value : []);
    s.helcimState = 'ok';
  } catch {
    if (seq !== s.fetchSeq) return;
    s.helcim = []; s.helcimState = 'error';
  }
  drawBody(body);
}

// Muse recorded card money per day from the synced staged rows (sales_card +
// gift_sold). Approved rows keep their syncType/amount, so this covers pending AND
// posted days; a day is "pending" if any contributing row is still unapproved.
function museCardByDay(from, to) {
  const byDay = new Map(); // date -> { cents, pending }
  for (const r of entities('staged')) {
    if (r.syncType !== 'sales_card' && r.syncType !== 'gift_sold') continue;
    if (!r.date || r.date < from || r.date > to) continue;
    const cur = byDay.get(r.date) || { cents: 0, pending: false };
    cur.cents += (r.amountCents || 0);
    if (r.status === 'pending') cur.pending = true;
    byDay.set(r.date, cur);
  }
  return byDay;
}

function drawBody(body) {
  const { from, to } = s;
  const muse = museCardByDay(from, to);
  const helcimDays = new Map(helcimDayTotals(s.helcim || [])
    .filter(d => d.date >= from && d.date <= to)
    .map(d => [d.date, d.grossCents]));
  const { rows: dayRows, rate, totMuse, totHelcim, flagCount } = summarizeDeposits(muse, helcimDays);

  const rows = dayRows.map(({ date: day, museCents: mc, musePending, helcimCents: hc, hasMuse, hasHelcim, delta, flag }) =>
    el('tr', {},
      el('td', {}, day),
      el('td', { class: 'num' }, hasMuse
        ? el('span', {}, fmtMoney(mc), musePending ? el('span', { class: 'pill amber', style: 'margin-left:6px' }, 'pending') : null)
        : el('span', { class: 'sub' }, '—')),
      el('td', { class: 'num' }, hasHelcim ? fmtMoney(hc) : el('span', { class: 'sub' }, '—')),
      el('td', { class: 'num' + (hasMuse && hasHelcim ? (delta < 0 ? ' neg' : ' pos') : '') },
        hasMuse && hasHelcim ? fmtMoney(delta, { sign: true }) : el('span', { class: 'sub' }, '—')),
      el('td', {}, flag ? el('span', { class: 'pill ' + flag.cls }, flag.text) : el('span', { class: 'pill green' }, 'OK')))
  );

  const fromIn = el('input', { class: 'field-input', type: 'date', value: from, max: to, style: 'max-width:160px',
    onchange: (e) => { s.from = e.target.value; if (s.from > s.to) s.to = s.from; loadHelcim(body); } });
  const toIn = el('input', { class: 'field-input', type: 'date', value: to, min: from, style: 'max-width:160px',
    onchange: (e) => { s.to = e.target.value; if (s.to < s.from) s.from = s.to; loadHelcim(body); } });

  const helcimNote = {
    loading: el('span', { class: 'sub' }, 'Loading Helcim…'),
    unconfigured: el('span', { class: 'pill amber' }, 'Helcim not connected'),
    error: el('span', { class: 'pill red' }, 'Helcim unreachable'),
    ok: el('span', { class: 'sub' }, `${(s.helcim || []).length} Helcim transactions in range`),
    idle: el('span'),
  }[s.helcimState] || el('span');

  clear(body).append(
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px' },
      labeled('From', fromIn), labeled('To', toIn),
      el('div', { style: 'align-self:center' }, helcimNote)),
    el('div', { class: 'row', style: 'margin-bottom:14px' },
      kpi('Muse recorded (card + gift)', fmtMoney(totMuse)),
      kpi('Helcim gross', fmtMoney(totHelcim)),
      kpi('Typical surcharge', rate == null ? '—' : (rate * 100).toFixed(2) + '%', rate == null ? 'needs days with both sides' : 'learned from this range'),
      kpi('Days flagged', String(flagCount), flagCount ? 'see the table' : 'all days tie out')),
    dayRows.length
      ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:860px' },
          el('table', { class: 'data xl' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Date'),
              el('th', { class: 'num' }, 'Muse recorded'),
              el('th', { class: 'num' }, 'Helcim gross'),
              el('th', { class: 'num' }, 'Δ surcharge'),
              el('th', {}, 'Status'))),
            el('tbody', {}, ...rows)))
      : el('p', { class: 'sub' }, 'No card sales or Helcim activity in this range.'),
    el('p', { class: 'sub', style: 'max-width:860px;margin-top:12px' },
      'Δ surcharge is Helcim gross minus Muse recorded — the customer surcharge Helcim added. With Fee Saver the bank deposit lands close to the Muse number (Helcim keeps the surcharge as its fee). Matching each bank deposit to its Helcim settlement batch — and posting the fee — comes next.'),
  );
}

const labeled = (label, node) => el('div', {}, el('label', { class: 'field-label' }, label), node);
const kpi = (label, value, note = '') => el('div', { class: 'card', style: 'flex:1;min-width:190px' },
  el('div', { class: 'kpilbl' }, label), el('div', { class: 'kpi' }, value),
  note ? el('div', { class: 'sub', style: 'margin:0' }, note) : null);
