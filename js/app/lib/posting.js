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

// Split eligibility for the edit modal: a txn is a divisible CATEGORY split when it has
// exactly one bank line and every other line is a non-bank category on the side OPPOSITE the
// bank line (uniform sign). A mixed-sign one-bank txn — a fee-split deposit (bank +net,
// income −gross, fee +fee) or a journal — is NOT a divisible category; editing it must stay
// on the metadata-only path, or the magnitude-based split editor would read it as unbalanced
// and a uniform re-sign would silently flip income↔expense. `isBank(accountId) → bool`. Pure.
export function splitParts(lines, isBank) {
  const ls = Array.isArray(lines) ? lines : [];
  const bankLines = ls.filter(l => isBank(l.accountId));
  const bankLine = bankLines.length === 1 ? bankLines[0] : null;
  const catLines = bankLine ? ls.filter(l => l !== bankLine) : [];
  const catSign = bankLine ? -Math.sign(bankLine.amountCents) : 0;
  const canSplit = !!bankLine && catLines.length >= 1
    && catLines.every(l => !isBank(l.accountId) && Math.sign(l.amountCents) === catSign);
  return { bankLine, catLines, canSplit };
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

// Decide how a split's invoice tags are stored, so both split editors (Review + the ledger) produce
// the SAME shape and the common case is revert-safe. Given each category line's chosen invoice id
// (''/undefined = untagged) and a whole-txn fallback (a client-suggested invoice, or the ledger's
// txn-level picker), returns { txnInvoiceId, perLine } aligned to the input:
//   • every line the SAME invoice → stamp it at the txn level, clear per-line (old code still reads it).
//   • lines span multiple invoices (or a mix) → keep per-line, no txn-level.
//   • no line tagged → the whole-txn fallback (else nothing).
// Pure — the one place the "collapse vs per-line" rule lives.
export function resolveSplitInvoiceTags(lineInvoiceIds, noneFallback) {
  const eff = (lineInvoiceIds || []).map(x => x || '');
  const distinct = [...new Set(eff.filter(Boolean))];
  if (eff.length && eff.every(Boolean) && distinct.length === 1) {
    return { txnInvoiceId: distinct[0], perLine: eff.map(() => undefined) };
  }
  if (distinct.length >= 1) {
    return { txnInvoiceId: undefined, perLine: eff.map(x => x || undefined) };
  }
  return { txnInvoiceId: noneFallback || undefined, perLine: eff.map(() => undefined) };
}

// The invoice a txn LINE is attributed to: its own tag wins, else the transaction's. A split can
// charge different lines to different invoices; a plain (untagged-line) txn attributes every line to
// its txn-level invoiceId, so existing transactions behave exactly as before.
export function lineInvoiceId(line, txn) {
  return (line && line.invoiceId) || (txn && txn.invoiceId) || undefined;
}

// Total expense (incl. COGS) attributed to one invoice — PER LINE (line.invoiceId ?? txn.invoiceId).
// Expense/COGS lines are debit-positive, so the sum is a positive "cost" in cents. Posted only. Used
// for per-invoice profit margin = invoice total − this. Back-compat: a txn tagged only at the txn
// level sums all its expense lines to that invoice (identical to the old txn-level behavior).
export function invoiceExpensesTotal(txns, accountsById, invoiceId) {
  let total = 0;
  for (const t of txns) {
    if (!counts(t)) continue;
    for (const l of (t.lines || [])) {
      const a = accountsById.get(l.accountId);
      if (a && (a.type === 'expense' || a.type === 'cogs') && lineInvoiceId(l, t) === invoiceId) total += l.amountCents;
    }
  }
  return total;
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
