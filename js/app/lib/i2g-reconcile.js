// ── lib: i2g-reconcile — match Invoice2go payouts to bank deposits ─────────────
// Pure (no DOM/IO). Each Invoice2go payout pays a batch of card payments out to the
// bank; netToBankCents (= the payout amount minus the 1% instant-payout fee) is the
// amount that actually lands as a bank deposit. So one payout ↔ one deposit.
//
// Greedy exact-amount match within a date window (a deposit lands on/near the payout
// date). Whatever's left over on each side is an exception list:
//   • unmatchedPayouts  — Invoice2go said it paid out, but no bank deposit fits → investigate
//   • unmatchedDeposits — bank money-in that isn't an Invoice2go payout → other income
//
// deposits: [{ id, date:'YYYY-MM-DD', amountCents (>0), ... }]
// payouts:  [{ id, date:'YYYY-MM-DD', netToBankCents, ... }]
export function reconcilePayouts(payouts, deposits, { windowBefore = 2, windowAfter = 6 } = {}) {
  const used = new Set();
  const matches = [], unmatchedPayouts = [];
  const day = (s) => Date.parse((s || '') + 'T12:00:00Z');
  const within = (d, p) => { const dd = (day(d.date) - day(p.date)) / 864e5; return dd >= -windowBefore && dd <= windowAfter; };
  // Match earliest payouts first; for each, take the closest-dated unused deposit of
  // the exact amount (so two same-amount payouts don't both grab the same deposit).
  const sorted = payouts.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const p of sorted) {
    let best = null, bestGap = Infinity;
    for (const d of deposits) {
      if (used.has(d.id) || d.amountCents !== p.netToBankCents || !within(d, p)) continue;
      const gap = Math.abs(day(d.date) - day(p.date));
      if (gap < bestGap) { best = d; bestGap = gap; }
    }
    if (best) { used.add(best.id); matches.push({ payout: p, deposit: best }); }
    else unmatchedPayouts.push(p);
  }
  const unmatchedDeposits = deposits.filter(d => !used.has(d.id));
  return { matches, unmatchedPayouts, unmatchedDeposits };
}
