// ── do: plaid-dedup — which synced rows are actually NEW (pure) ────────────────
// Split out of business.js so it can be tested without a Durable Object.
//
// Plaid's transaction_id is unique PER ITEM. Re-linking a bank mints a new Item, so
// the SAME transactions come back with brand-new ids — an id-only check can't tell
// they're the same money. On 2026-07-17 that put Honey - 8002's Apr 20 → Jul 13 range
// in Review twice (83 rows across two feeds), on the reconnect the app itself
// recommends. Rows already carry a content fingerprint (date|amount|desc, the same one
// the CSV importer matches on); nothing was comparing it.
//
// The fingerprint is COUNTED, not merely present. Two $200 ATM withdrawals on one day
// are one fingerprint and two real transactions — treating it as a set silently drops
// the second, which is the same disease (delivering less than you say) that this whole
// area exists to cure. Holding 1 and offered 2 stages exactly 1.

import { dedupHash } from '../../../js/app/lib/csv.js';

// A row's CONTENT fingerprint, recomputed — never the stored field. banking.js stores
// `ofx:<fitid>` for an OFX/QFX row instead of a content hash, so trusting the stored
// value makes every OFX-imported row invisible here (the CSV importer works around
// this by carrying both). A row with no description can't be fingerprinted; skip it
// rather than let dedupHash's unguarded .toLowerCase() throw and fail the whole sync.
const contentHash = (r) => (r && r.desc && r.date && typeof r.amountCents === 'number')
  ? dedupHash({ date: r.date, desc: r.desc, amountCents: r.amountCents })
  : null;

// txns:       shaped staged rows from this sync
// byId:       Map(stagedId -> stored row)                — same-feed idempotency
// countByAcct: Map(bankacctId -> Map(hash -> howMany))   — same money, ANY source
// now:        timestamp to stamp
export function freshRows(txns, byId, countByAcct, now) {
  const out = [];
  // Copy per account so this batch spends the same budget without mutating the caller's.
  const budgets = new Map();
  const budgetFor = (acct) => {
    if (!budgets.has(acct)) budgets.set(acct, new Map(countByAcct.get(acct) || []));
    return budgets.get(acct);
  };
  const emitted = new Set();   // one page's `added` can repeat in another's `modified`

  for (const r of txns || []) {
    if (!r?.id || emitted.has(r.id)) continue;
    const existing = byId.get(r.id);
    if (existing) {
      // Same feed, same row. Plaid restates a pending row once it settles, so let a real
      // change through — but an approved row has already posted to the ledger and must
      // never be dragged back to pending.
      if (existing.status === 'pending'
        && (existing.amountCents !== r.amountCents || existing.desc !== r.desc || existing.date !== r.date)) {
        out.push({ ...existing, ...r, updatedAt: now, updatedBy: 'plaid' });
        emitted.add(r.id);
      }
      continue;
    }
    // New id — but is this money we already hold? Per ACCOUNT: the same shop, price and
    // day on two different cards is two real transactions.
    const hash = contentHash(r);
    const budget = budgetFor(r.bankacctId);
    if (hash && budget.get(hash) > 0) { budget.set(hash, budget.get(hash) - 1); continue; }
    out.push({ ...r, createdAt: now, updatedAt: now, updatedBy: 'plaid' });
    emitted.add(r.id);
  }
  return out;
}

// Every staged row in the DO, as {byId, countByAcct}. Paginated: storage.list() defaults
// to 128 keys, and a short read here would silently let duplicates through — the same
// trap that once truncated snapshot().
export async function stagedIndex(storage) {
  const byId = new Map();
  const countByAcct = new Map();
  let cursor;
  while (true) {
    const batch = await storage.list({ prefix: 'staged:', limit: 1000, ...(cursor ? { startAfter: cursor } : {}) });
    if (!batch.size) break;
    for (const [k, v] of batch) {
      if (!v) continue;
      byId.set(k.slice('staged:'.length), v);
      const hash = contentHash(v);
      if (!v.bankacctId || !hash) continue;
      if (!countByAcct.has(v.bankacctId)) countByAcct.set(v.bankacctId, new Map());
      const m = countByAcct.get(v.bankacctId);
      m.set(hash, (m.get(hash) || 0) + 1);
    }
    if (batch.size < 1000) break;
    cursor = [...batch.keys()].at(-1);
  }
  return { byId, countByAcct };
}
