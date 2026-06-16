// ── lib: qb-history-import — reconstructed QB-history bundle → entity payloads ──
// Pure (no DOM/IO). Takes the offline-reconstructed bundle (accounts + money
// accounts + posted double-entry transactions, produced from a QuickBooks
// "Transaction Detail by Account" export) and the current store state, then:
//   • merges the chart of accounts (existing ids win — re-import is safe),
//   • pairs each money account with a bankacct entity (needed for Reconcile),
//   • resolves each "Inv. ####" memo to an existing invoice.id (job-cost tag),
//   • pre-marks QB-cleared transactions reconciled (one recon per money account),
//   • validates every transaction with the real posting engine.
// Returns { ops-ready arrays, preview, errors }. The caller dispatches.

import { validateTxn } from './posting.js';

const bankLineOn = (t, accountId) => (t.lines || []).filter(l => l.accountId === accountId).reduce((s, l) => s + l.amountCents, 0);

export function buildQbImport(bundle, { existingAccounts = [], existingBankaccts = [], existingInvoices = [], now = 0 } = {}) {
  const errors = [];
  if (!bundle || !Array.isArray(bundle.accounts) || !Array.isArray(bundle.transactions)) {
    return { errors: ['That file is not a QuickBooks history bundle (missing accounts/transactions).'] };
  }

  // 1) chart of accounts — keep accounts that already exist (merge by id), add the rest
  const existingAcctIds = new Set(existingAccounts.map(a => a.id));
  const accountsToAdd = bundle.accounts.filter(a => !existingAcctIds.has(a.id))
    .map(a => ({ id: a.id, name: a.name, type: a.type, qbType: a.qbType, qbName: a.qbName || a.name, parentId: a.parentId || null, active: true }));
  // accountsById covers both existing and incoming — validateTxn needs every line's account present
  const accountsById = new Map(existingAccounts.map(a => [a.id, a]));
  for (const a of bundle.accounts) if (!accountsById.has(a.id)) accountsById.set(a.id, a);

  // 2) money accounts → bankacct entities (skip ones already linked)
  const linkedAcctIds = new Set(existingBankaccts.map(b => b.accountId));
  const bankaccts = (bundle.bankaccts || []).filter(b => !linkedAcctIds.has(b.accountId))
    .map(b => ({ id: b.id, name: b.name, accountId: b.accountId, kind: b.kind || 'checking', institution: b.institution || '', mapping: null }));
  const bankacctByAcct = new Map();
  for (const b of [...existingBankaccts, ...(bundle.bankaccts || [])]) if (!bankacctByAcct.has(b.accountId)) bankacctByAcct.set(b.accountId, b.id);

  // 3) invoice number → id (job-cost tagging); track which numbers never matched
  const invByNumber = new Map();
  for (const inv of existingInvoices) if (inv.number) invByNumber.set(String(inv.number).trim(), inv.id);
  const unmatchedInvoices = new Map(); // number → {count, cents}

  // 4) transactions — resolve invoice, validate, collect cleared sets per money account
  const ctx = { accountsById, locks: new Set() };
  const transactions = [];
  const clearedByAcct = new Map(); // accountId → [txnId]
  let tagged = 0;
  for (const t of bundle.transactions) {
    const tx = {
      id: t.id, date: t.date, payee: t.payee || '', memo: t.memo || '', checkNo: t.num || '',
      lines: t.lines, status: 'posted', source: t.source || { app: 'qb-detail', sourceId: t.id },
    };
    if (t.invoiceNum) {
      const id = invByNumber.get(String(t.invoiceNum).trim());
      if (id) { tx.invoiceId = id; tagged++; }
      else { const u = unmatchedInvoices.get(t.invoiceNum) || { count: 0, cents: 0 }; u.count++; u.cents += Math.abs((t.lines[0] || {}).amountCents || 0); unmatchedInvoices.set(t.invoiceNum, u); }
    }
    const v = validateTxn(tx, ctx);
    if (!v.ok) { errors.push(`txn ${t.id} (${t.date}): ${v.error}`); continue; }
    transactions.push(tx);
    for (const accId of (t.clearedAccountIds || [])) (clearedByAcct.get(accId) || clearedByAcct.set(accId, []).get(accId)).push(tx);
  }

  // 5) pre-mark cleared transactions reconciled — one synthetic recon per money account
  const recons = [];
  for (const [accountId, txs] of clearedByAcct) {
    const bankacctId = bankacctByAcct.get(accountId); if (!bankacctId) continue;
    const reconId = 'rec-qb-' + bankacctId;
    const endDate = txs.reduce((m, t) => t.date > m ? t.date : m, '0000-00-00');
    const balanceCents = txs.reduce((s, t) => s + bankLineOn(t, accountId), 0);
    const ids = [];
    for (const t of txs) { if (!t.reconciledIn) t.reconciledIn = reconId; ids.push(t.id); } // first money account claims a shared txn
    recons.push({ id: reconId, bankacctId, statementEndDate: endDate, statementBalanceCents: balanceCents, clearedTxnIds: ids, closedAt: now });
  }

  // 6) per-money-account computed balance (so the user can eyeball vs QuickBooks)
  const moneyBalances = (bundle.bankaccts || []).map(b => ({
    name: b.name, accountId: b.accountId,
    cents: transactions.reduce((s, t) => s + bankLineOn(t, b.accountId), 0),
  }));

  return {
    errors,
    accountsToAdd, bankaccts, transactions, recons,
    enableInvoices: true,
    preview: {
      totalTxns: transactions.length,
      skipped: bundle.transactions.length - transactions.length,
      newAccounts: accountsToAdd.length,
      existingAccounts: bundle.accounts.length - accountsToAdd.length,
      newBankaccts: bankaccts.length,
      reconciledTxns: [...clearedByAcct.values()].reduce((s, a) => s + a.length, 0),
      taggedInvoices: tagged,
      unmatchedInvoices: [...unmatchedInvoices.entries()].map(([number, u]) => ({ number, ...u })).sort((a, b) => b.count - a.count),
      moneyBalances,
      dateRange: bundle.dateRange || null,
    },
  };
}
