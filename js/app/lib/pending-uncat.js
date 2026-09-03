// ── lib: pending-uncat — provisional income/expense from items still in Review (pure) ──────────────
// The P&L can optionally fold in transactions still waiting in Review (status 'pending'), bucketed by
// bank-feed SIGN: money-in (amountCents > 0) → income, money-out (< 0) → expense (returned positive).
// These are PROVISIONAL, not posted and not double-entry: they may include transfers/refunds and can
// double-count money already booked — the caller labels them as an estimate. Date filter: a null bound
// is unbounded, a set bound is inclusive (matching activityByAccount, posting.js:81, for DATED rows).
// An undated row is deliberately excluded once any bound is set (a stricter choice than posted txns,
// which count undated in every range) so it can't leak into a specific period's P&L; staged rows are
// effectively always dated, so this is an edge guard, not a behavior anyone relies on.
export function pendingUncategorized(staged, { from, to } = {}) {
  let inc = 0, exp = 0, count = 0;
  for (const r of (staged || [])) {
    if (!r || r.status !== 'pending') continue;
    const amt = r.amountCents || 0;
    if (!amt) continue;
    const d = r.date || '';
    if (from && d < from) continue;
    if (to && d > to) continue;
    if (amt > 0) inc += amt; else exp += -amt;
    count++;
  }
  return { inc, exp, count };
}
