// ── lib: qb-iif — QuickBooks Desktop IIF export writer (pure, no DOM/IO) ────────
// IIF is tab-delimited text with `!`-prefixed header rows. We emit two sections:
//   !ACCNT — the chart of accounts (NAME + ACCNTTYPE), so QB auto-creates any
//            account it doesn't have before the transactions reference it.
//   !TRNS/!SPL/!ENDTRNS — every POSTED txn in range as a GENERAL JOURNAL entry:
//            the first line is the TRNS row, the rest are SPL rows; QB requires
//            the rows of one entry to sum to zero, which our ledger guarantees.
// Accounts use qbName (falling back to name) and qbType (falling back by our
// account type); subaccounts become QB's `Parent:Child` colon naming. Values are
// sanitized because a literal tab or newline inside a field corrupts the file.

const QB_TYPE_FALLBACK = {
  asset: 'OCASSET', liability: 'OCLIAB', equity: 'EQUITY',
  income: 'INC', cogs: 'COGS', expense: 'EXP',
  // QB Desktop has no separate below-the-line type in IIF; export both as EXP.
  'other-expense': 'EXP', 'personal-expense': 'EXP',
};

const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();

export function qbTypeFor(acct) {
  return acct?.qbType || QB_TYPE_FALLBACK[acct?.type] || 'EXP';
}

// `Parent:Child` per QB; one level deep matches our subaccount model, but the
// loop walks any depth defensively (and bails on a cycle).
export function qbAccountName(acct, accountsById) {
  let name = clean(acct.qbName || acct.name);
  let cur = acct, hops = 0;
  while (cur?.parentId && hops++ < 5) {
    cur = accountsById.get(cur.parentId);
    if (!cur) break;
    name = `${clean(cur.qbName || cur.name)}:${name}`;
  }
  return name;
}

const qbDate = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${m}/${d}/${y}`;
};
const qbAmount = (cents) => (cents / 100).toFixed(2);

// accounts: every account (QB creates the missing ones); txns: ledger txns —
// only POSTED entries inside [from, to] (inclusive, 'YYYY-MM-DD') are written.
export function buildIif({ accounts = [], txns = [], from, to }) {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const nameFor = (id) => {
    const a = accountsById.get(id);
    return a ? qbAccountName(a, accountsById) : `Unknown ${id}`;
  };

  const lines = [];
  lines.push('!ACCNT\tNAME\tACCNTTYPE');
  for (const a of accounts) {
    lines.push(`ACCNT\t${qbAccountName(a, accountsById)}\t${qbTypeFor(a)}`);
  }

  lines.push('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
  lines.push('!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
  lines.push('!ENDTRNS');

  const inRange = txns
    .filter(t => t.status === 'posted' && (!from || t.date >= from) && (!to || t.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));

  for (const t of inRange) {
    const date = qbDate(t.date), payee = clean(t.payee), memo = clean(t.memo), doc = clean(t.checkNo);
    t.lines.forEach((l, i) => {
      const tag = i === 0 ? 'TRNS' : 'SPL';
      lines.push(`${tag}\t\tGENERAL JOURNAL\t${date}\t${nameFor(l.accountId)}\t${payee}\t${qbAmount(l.amountCents)}\t${doc}\t${memo}`);
    });
    lines.push('ENDTRNS');
  }

  // QB Desktop is a Windows program — CRLF keeps old versions happy.
  return { text: lines.join('\r\n') + '\r\n', count: inRange.length, txns: inRange };
}
