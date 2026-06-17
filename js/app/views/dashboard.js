// ── view: dashboard ────────────────
import { el, fmtMoney, modal } from '../ui.js';
import { getState, subscribe, entities } from '../store.js';
import { getActiveBiz } from '../session.js';
import { industryLabel, accountLabel } from '../lib/coa-templates.js';
import { profitAndLoss } from '../lib/posting.js';

let unsub = null;

// 'YYYY-MM' for the month before the given one.
function prevMonthKey(month) {
  const [y, m] = month.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}
const monthRange = (mk) => ({ from: `${mk}-01`, to: `${mk}-31` });
const monthName = (mk) => new Date(`${mk}-15T00:00:00`).toLocaleDateString('en-US', { month: 'long' });
// Account balance as of a date — sum of posted lines on that account through `asOf`.
const balanceAsOf = (txns, accountId, asOf) => txns.reduce((s, t) =>
  (t.status === 'posted' && (!asOf || t.date <= asOf))
    ? s + (t.lines || []).reduce((a, l) => a + (l.accountId === accountId ? l.amountCents : 0), 0)
    : s, 0);
const todayIso = () => new Date().toISOString().slice(0, 10);

export function render(root) {
  let asOf = todayIso();
  const body = el('div');
  const asOfInput = el('input', { class: 'field-input', type: 'date', value: asOf, max: todayIso(), style: 'max-width:160px', onchange: (e) => { asOf = e.target.value || todayIso(); draw(); } });
  const draw = () => {
    const s = getState();
    const biz = getActiveBiz();
    const txns = entities('txn');
    const accounts = entities('account');
    const accountsById = new Map(accounts.map(a => [a.id, a]));

    // The registered bank/card accounts (same set the Ledger's per-account chips use),
    // so a widget row links straight to that account's register.
    const banks = entities('bankacct')
      .map(b => accountsById.get(b.accountId)).filter(Boolean)
      .sort((a, b) => accountLabel(a, accountsById).localeCompare(accountLabel(b, accountsById)));
    // Cash position = BANK-type asset accounts only (excludes credit cards).
    const cashAccts = banks.filter(a => a.type === 'asset' && a.qbType === 'BANK');
    const cash = cashAccts.reduce((sum, a) => sum + balanceAsOf(txns, a.id, asOf), 0);

    const month = new Date().toISOString().slice(0, 7);
    const prev = prevMonthKey(month);
    const pl = profitAndLoss(txns, accountsById, monthRange(month));
    const plPrev = profitAndLoss(txns, accountsById, monthRange(prev));
    const staged = entities('staged').filter(r => r.status === 'pending').length;

    const goRegister = (accountId) => { location.hash = `#/b/${biz}/ledger/${accountId}`; };

    // KPI #1 — Cash → per-bank balances, each row opens that register.
    const openCash = () => drillModal(`Cash position — as of ${asOf}`, cashAccts.length
      ? cashAccts.map(a => ({ label: accountLabel(a, accountsById), cents: balanceAsOf(txns, a.id, asOf), onclick: () => goRegister(a.id) }))
      : [], { total: cash, empty: 'No bank-type accounts yet.' });

    // KPI #2/#3 — income / expenses → by category, each row opens that account's register.
    const openCats = (title, list, total) => drillModal(title, list.map(r => ({
      label: accountLabel(r.account, accountsById), cents: r.cents, onclick: () => goRegister(r.account.id),
    })), { total, empty: 'No posted activity this month.' });

    // KPI #4 — Net → a mini P&L.
    const openNet = () => {
      const { body: mb } = modal(`Net — ${monthName(month)}`);
      mb.append(
        el('table', { class: 'data' },
          miniRow('Income', pl.incomeTotal, 'pos'),
          miniRow('Expenses', -pl.expenseTotal, 'neg'),
          el('tr', { style: 'border-top:2px solid var(--line)' },
            el('td', { style: 'font-weight:800' }, 'Net profit'),
            el('td', { class: 'num ' + (pl.netCents < 0 ? 'neg' : 'pos'), style: 'text-align:right;font-weight:800' }, fmtMoney(pl.netCents, { sign: true })))),
        el('p', { class: 'sub', style: 'margin:12px 0 0' },
          `vs ${fmtMoney(plPrev.netCents, { sign: true })} in ${monthName(prev)}.`),
      );
    };

    const hasAccounts = accounts.length > 0;
    body.replaceChildren(
      el('h2', {}, s.meta?.name || biz),
      el('p', { class: 'sub' }, s.meta
        ? `${industryLabel(s.meta.industry)} · fiscal year starts ${s.meta.fiscalYearStart || 'January'}`
        : 'Business profile not set up yet.'),
      !hasAccounts ? el('div', { class: 'card', style: 'max-width:560px;border-color:var(--amber)' },
        el('div', { class: 'cardtitle' }, 'Get started'),
        el('p', { class: 'sub' }, 'No accounts yet. Go to Banking to add a checking account and import your first CSV, or go to Accounts to build the chart of accounts first.'),
        el('div', { style: 'display:flex;gap:9px' },
          el('a', { class: 'btn sm', href: `#/b/${biz}/banking` }, 'Banking'),
          el('a', { class: 'btn sm ghost', href: `#/b/${biz}/accounts` }, 'Accounts'))) : el('span'),
      el('div', { class: 'sticky-toolbar' }, el('span', { class: 'sub', style: 'margin:0' }, 'Cash position as of'), asOfInput),
      el('div', { class: 'row' },
        kpi('Cash position', fmtMoney(cash), `${cashAccts.length} bank account${cashAccts.length === 1 ? '' : 's'} · as of ${asOf}`, openCash),
        kpi(`${monthName(month)} income`, fmtMoney(pl.incomeTotal), deltaNote(pl.incomeTotal, plPrev.incomeTotal, prev),
          pl.income.length ? () => openCats(`${monthName(month)} income`, pl.income, pl.incomeTotal) : null, 'pos'),
        kpi(`${monthName(month)} expenses`, fmtMoney(pl.expenseTotal), deltaNote(pl.expenseTotal, plPrev.expenseTotal, prev),
          pl.expenses.length ? () => openCats(`${monthName(month)} expenses`, pl.expenses, pl.expenseTotal) : null, 'neg'),
        kpi('Net this month', fmtMoney(pl.netCents, { sign: true }), staged ? `${staged} row${staged === 1 ? '' : 's'} waiting in Review` : 'nothing waiting in Review',
          openNet, pl.netCents < 0 ? 'neg' : 'pos'),
      ),
      hasAccounts ? bankWidget(banks, txns, accountsById, staged, biz, goRegister, asOf) : el('span'),
    );
  };
  unsub = subscribe(draw);
  draw();
  root.append(body);
}

// A clickable KPI card. `onClick` null → static card (no pointer affordance).
function kpi(label, value, note, onClick, valueClass = '') {
  const card = el('div', { class: 'card' + (onClick ? ' kpi-card' : ''), style: 'flex:1;min-width:190px' },
    el('div', { class: 'kpilbl' }, label),
    el('div', { class: 'kpi ' + valueClass }, value),
    el('div', { class: 'sub', style: 'margin:0' }, note),
    onClick ? el('div', { class: 'kpi-more' }, 'View details ›') : null);
  if (onClick) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', onClick);
  }
  return card;
}

// "vs $X in May" — a one-line month-over-month comparison for a KPI note.
function deltaNote(cur, prev, prevKey) {
  if (!prev) return 'posted entries only';
  return `vs ${fmtMoney(prev)} in ${monthName(prevKey)}`;
}

// A generic drill-down modal: a list of label/amount rows with a total footer.
// Rows with an onclick are clickable (→ a register).
function drillModal(title, rows, { total, empty } = {}) {
  const { body: mb, close } = modal(title);
  if (!rows.length) { mb.append(el('p', { class: 'sub', style: 'margin:0' }, empty || 'Nothing to show.')); return; }
  const table = el('table', { class: 'data' },
    ...rows.map(r => {
      const tr = el('tr', {},
        el('td', {}, r.label),
        el('td', { class: 'num ' + (r.cents < 0 ? 'neg' : ''), style: 'text-align:right;font-variant-numeric:tabular-nums' }, fmtMoney(r.cents)));
      if (r.onclick) { tr.style.cursor = 'pointer'; tr.addEventListener('click', () => { close(); r.onclick(); }); }
      return tr;
    }),
    total != null ? el('tr', { style: 'border-top:2px solid var(--line)' },
      el('td', { style: 'font-weight:800' }, 'Total'),
      el('td', { class: 'num', style: 'text-align:right;font-weight:800;font-variant-numeric:tabular-nums' }, fmtMoney(total))) : null,
  );
  mb.append(table);
  if (rows.some(r => r.onclick)) mb.append(el('p', { class: 'sub', style: 'margin:12px 0 0' }, 'Click a row to open its register.'));
}

function miniRow(label, cents, cls) {
  return el('tr', {},
    el('td', {}, label),
    el('td', { class: 'num ' + cls, style: 'text-align:right;font-variant-numeric:tabular-nums' }, fmtMoney(cents, { sign: true })));
}

// QuickBooks-style bank-accounts widget: one clickable row per registered
// bank/card account → its ledger register.
function bankWidget(banks, txns, accountsById, staged, biz, goRegister, asOf) {
  if (!banks.length) return el('span');
  const rows = banks.map(a => {
    const bal = balanceAsOf(txns, a.id, asOf);
    const tr = el('tr', { style: 'cursor:pointer' },
      el('td', {},
        el('span', { class: 'ms', style: 'color:var(--brand);vertical-align:middle;margin-right:8px;font-size:18px' },
          a.qbType === 'CCARD' ? 'credit_card' : 'account_balance'),
        accountLabel(a, accountsById)),
      el('td', { class: 'num ' + (bal < 0 ? 'neg' : ''), style: 'text-align:right;font-weight:700;font-variant-numeric:tabular-nums' }, fmtMoney(bal)));
    tr.addEventListener('click', () => goRegister(a.id));
    return tr;
  });
  return el('div', { class: 'card', style: 'max-width:560px;margin-top:16px' },
    el('div', { class: 'cardtitle' },
      el('span', { class: 'ms', style: 'color:var(--brand);vertical-align:middle;margin-right:6px' }, 'account_balance_wallet'),
      'Bank accounts'),
    el('table', { class: 'data' }, ...rows),
    staged ? el('p', { class: 'sub', style: 'margin:12px 0 0' },
      el('a', { class: 'linklike', href: `#/b/${biz}/review` }, `${staged} row${staged === 1 ? '' : 's'} waiting in Review ›`)) : null);
}

export function unmount() { unsub?.(); unsub = null; }
