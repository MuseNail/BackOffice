// ── lib: posted-twin — "this staged row is already posted" transfer-dup check (pure) ──────────────
// A transfer imported from one account's statement and posted shows up again on the OTHER account's
// feed as a staged row; approving it would move the money twice. This flags that: a staged row whose
// (bank account, amount) matches one bank side of an already-posted TRANSFER (a txn with two different
// bank/card lines), within a few days. Restricted to transfers so it never cries wolf on two genuine
// same-amount charges (a recurring bill, two coffees).
//
// Built ONCE per Review render (buildPostedTwinIndex) then looked up O(1) per row (findPostedTwin),
// instead of re-scanning every transaction for every row.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Noon-anchored (not bare-date UTC midnight) so the whole-day ± window compare in findPostedTwin
// can't slip a day across timezones/DST.
const dayMs = (d) => new Date(d + 'T12:00:00').getTime();

// Index posted transfers by each bank side's `accountId|amountCents` → [{ txn, when }]. `bankAcctIds`
// is a Set of the ledger account ids that are bank/card accounts.
export function buildPostedTwinIndex(txns, bankAcctIds) {
  const idx = new Map();
  for (const t of (txns || [])) {
    if (!t || t.status !== 'posted' || !DATE_RE.test(t.date || '')) continue;
    const bankLines = (t.lines || []).filter(l => l && bankAcctIds.has(l.accountId));
    if (bankLines.length < 2) continue;                      // not a transfer
    const when = dayMs(t.date);
    for (const l of bankLines) {
      // this line is a valid twin target only if ANOTHER bank line is a DIFFERENT account.
      if (!bankLines.some(o => o.accountId !== l.accountId)) continue;
      const key = l.accountId + '|' + l.amountCents;
      let list = idx.get(key);
      if (!list) idx.set(key, list = []);
      list.push({ txn: t, when });
    }
  }
  return idx;
}

// The already-posted transfer whose bank side matches (bankAccountId, amountCents) within `dupDays`
// of `rowDate`, or null.
export function findPostedTwin(index, bankAccountId, amountCents, rowDate, dupDays = 3) {
  if (!DATE_RE.test(rowDate || '')) return null;
  const list = index && index.get(bankAccountId + '|' + amountCents);
  if (!list) return null;
  const when = dayMs(rowDate);
  const hit = list.find(e => Math.abs(e.when - when) <= dupDays * 86400000);
  return hit ? hit.txn : null;
}
