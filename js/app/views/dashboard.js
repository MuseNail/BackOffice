// ── view: dashboard ────────────────
import { el, fmtMoney } from '../ui.js';
import { getState, subscribe, entities } from '../store.js';
import { getActiveBiz } from '../session.js';
import { industryLabel } from '../lib/coa-templates.js';
import { accountBalance, profitAndLoss } from '../lib/posting.js';

let unsub = null;

export function render(root) {
  const body = el('div');
  const draw = () => {
    const s = getState();
    const txns = entities('txn');
    const accounts = entities('account');
    const accountsById = new Map(accounts.map(a => [a.id, a]));
    const bankAccts = accounts.filter(a => a.type === 'asset' && a.qbType === 'BANK' && a.active !== false);
    const cash = bankAccts.reduce((sum, a) => sum + accountBalance(txns, a.id), 0);
    const month = new Date().toISOString().slice(0, 7);
    const pl = profitAndLoss(txns, accountsById, { from: `${month}-01`, to: `${month}-31` });
    const staged = entities('staged').filter(r => r.status === 'pending').length;

    const hasAccounts = accounts.length > 0;
    body.replaceChildren(
      el('h2', {}, s.meta?.name || getActiveBiz()),
      el('p', { class: 'sub' }, s.meta
        ? `${industryLabel(s.meta.industry)} · fiscal year starts ${s.meta.fiscalYearStart || 'January'}`
        : 'Business profile not set up yet.'),
      !hasAccounts ? el('div', { class: 'card', style: 'max-width:560px;border-color:var(--amber)' },
        el('div', { class: 'cardtitle' }, 'Get started'),
        el('p', { class: 'sub' }, 'No accounts yet. Go to Banking to add a checking account and import your first CSV, or go to Accounts to build the chart of accounts first.'),
        el('div', { style: 'display:flex;gap:9px' },
          el('a', { class: 'btn sm', href: `#/b/${getActiveBiz()}/banking` }, 'Banking'),
          el('a', { class: 'btn sm ghost', href: `#/b/${getActiveBiz()}/accounts` }, 'Accounts'))) : el('span'),
      el('div', { class: 'row' },
        kpi('Cash position', fmtMoney(cash), `Sum of all BANK-type account balances from posted transactions (${bankAccts.length} account${bankAccts.length === 1 ? '' : 's'})`),
        kpi('This month — income', fmtMoney(pl.incomeTotal), 'posted entries only'),
        kpi('This month — expenses', fmtMoney(pl.expenseTotal), 'posted entries only'),
        kpi('Net this month', fmtMoney(pl.netCents), staged ? `${staged} imported rows waiting in Review` : 'nothing waiting in Review'),
      ),
    );
  };
  unsub = subscribe(draw);
  draw();
  root.append(body);
}

function kpi(label, value, note) {
  return el('div', { class: 'card', style: 'flex:1;min-width:190px' },
    el('div', { class: 'kpilbl' }, label),
    el('div', { class: 'kpi' }, value),
    el('div', { class: 'sub', style: 'margin:0' }, note));
}

export function unmount() { unsub?.(); unsub = null; }
