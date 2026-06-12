// ── lib: posting — the double-entry engine (pure, no DOM, no I/O) ────────────────
// Sign convention (debit-positive): a line's amountCents is + on the debit
// side, − on the credit side. Assets/expenses grow with +, liabilities/
// equity/income grow with −. Every transaction's lines sum to exactly 0.
//
// A txn: { id, date:'YYYY-MM-DD', payee?, memo?, checkNo?,
//          lines:[{accountId, amountCents}], status:'staged'|'posted'|'void',
//          source?:{app, sourceId?, importId?}, voidedAt? }

export function periodKey(date) { return String(date).slice(0, 7); } // 'YYYY-MM'

export function validateTxn(txn, { accountsById = new Map(), locks = new Set() } = {}) {
  if (!txn || typeof txn !== 'object') return { ok: false, error: 'no transaction' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txn.date || '')) return { ok: false, error: 'bad date' };
  if (!['staged', 'posted', 'void'].includes(txn.status)) return { ok: false, error: 'bad status' };
  if (!Array.isArray(txn.lines) || txn.lines.length < 2) return { ok: false, error: 'needs at least 2 lines' };
  let sum = 0;
  for (const l of txn.lines) {
    if (!l?.accountId) return { ok: false, error: 'line missing account' };
    if (!Number.isInteger(l.amountCents) || l.amountCents === 0) return { ok: false, error: 'line amounts are nonzero integer cents' };
    const acct = accountsById.get(l.accountId);
    if (!acct) return { ok: false, error: `unknown account ${l.accountId}` };
    if (acct.active === false) return { ok: false, error: `archived account ${acct.name}` };
    sum += l.amountCents;
  }
  if (sum !== 0) return { ok: false, error: `lines must balance (off by ${sum})` };
  if (txn.status === 'posted' && locks.has(periodKey(txn.date))) return { ok: false, error: `period ${periodKey(txn.date)} is locked` };
  return { ok: true };
}

// Single-entry UX → balanced double entry. direction 'out': money leaves the
// bank/cash account into a category (expense etc). 'in': money arrives.
export function simpleTxn({ id, date, payee, memo, checkNo, amountCents, direction, bankAccountId, categoryAccountId, source }) {
  const amt = Math.abs(amountCents);
  const bankLine = { accountId: bankAccountId, amountCents: direction === 'out' ? -amt : amt };
  const catLine = { accountId: categoryAccountId, amountCents: direction === 'out' ? amt : -amt };
  return {
    id, date, payee: payee || '', memo: memo || '', checkNo: checkNo || '',
    lines: [bankLine, catLine], status: 'posted',
    source: source || { app: 'manual' },
  };
}

// Voiding never deletes: the txn keeps its lines but stops counting anywhere.
export function voidTxn(txn, when) {
  return { ...txn, status: 'void', voidedAt: when };
}

const counts = (txn) => txn.status === 'posted';

// Balance of one account over posted txns (optionally date-bounded, inclusive).
export function accountBalance(txns, accountId, { from, to } = {}) {
  let sum = 0;
  for (const t of txns) {
    if (!counts(t)) continue;
    if (from && t.date < from) continue;
    if (to && t.date > to) continue;
    for (const l of t.lines) if (l.accountId === accountId) sum += l.amountCents;
  }
  return sum;
}

// Per-account totals over a range → Map(accountId → signed cents).
export function activityByAccount(txns, { from, to } = {}) {
  const out = new Map();
  for (const t of txns) {
    if (!counts(t)) continue;
    if (from && t.date < from) continue;
    if (to && t.date > to) continue;
    for (const l of t.lines) out.set(l.accountId, (out.get(l.accountId) || 0) + l.amountCents);
  }
  return out;
}

// P&L rollup: income shows positive when earned, expenses positive when spent.
export function profitAndLoss(txns, accountsById, range) {
  const act = activityByAccount(txns, range);
  const income = [], expenses = [];
  let incomeTotal = 0, expenseTotal = 0;
  for (const [accountId, cents] of act) {
    const a = accountsById.get(accountId);
    if (!a) continue;
    if (a.type === 'income') { income.push({ account: a, cents: -cents }); incomeTotal += -cents; }
    else if (a.type === 'expense' || a.type === 'cogs') { expenses.push({ account: a, cents }); expenseTotal += cents; }
  }
  income.sort((x, y) => y.cents - x.cents);
  expenses.sort((x, y) => y.cents - x.cents);
  return { income, expenses, incomeTotal, expenseTotal, netCents: incomeTotal - expenseTotal };
}
