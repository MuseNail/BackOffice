// ── lib: deposits-compare — per-day Muse-recorded vs Helcim-gross (pure) ───────
// Phase 2 of the Deposits feature. Given two per-day views of card money —
// museByDay (Map date→{cents,pending}, = sales_card + gift_sold from the synced
// rows) and helcimByDay (Map date→grossCents, from helcimDayTotals) — learn the
// typical Fee-Saver surcharge from the days that have BOTH sides (Helcim runs a
// little above Muse), then flag any day that doesn't fit. No DOM/IO.

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Returns { rows, rate, totMuse, totHelcim, flagCount }. Each row:
//   { date, museCents, musePending, helcimCents, hasMuse, hasHelcim, delta, flag }
// flag is null (ties out) or { cls:'amber'|'red', text }. rate is the learned
// surcharge fraction (median of Helcim-over-Muse on overlapping days), or null.
export function summarizeDeposits(museByDay, helcimByDay) {
  const days = [...new Set([...museByDay.keys(), ...helcimByDay.keys()])].sort();

  // Median ratio resists a one-off refund/outlier day; bound out nonsense (Helcim
  // below Muse, or "surcharge" over half the bill) so they don't skew the rate.
  const ratios = [];
  for (const day of days) {
    const mc = museByDay.get(day)?.cents || 0;
    const hc = helcimByDay.get(day) || 0;
    if (mc > 0 && hc > 0) { const d = hc - mc; if (d >= 0 && d < mc * 0.5) ratios.push(d / mc); }
  }
  const rate = median(ratios);

  let totMuse = 0, totHelcim = 0, flagCount = 0;
  const rows = days.map(day => {
    const m = museByDay.get(day);
    const museCents = m?.cents || 0;
    const helcimCents = helcimByDay.get(day) || 0;
    const hasMuse = museByDay.has(day), hasHelcim = helcimByDay.has(day);
    totMuse += museCents; totHelcim += helcimCents;
    const delta = helcimCents - museCents; // the surcharge Helcim added on top of the Muse bill

    let flag = null;
    if (hasMuse && !hasHelcim) flag = { cls: 'amber', text: 'No Helcim activity' };
    else if (hasHelcim && !hasMuse) flag = { cls: 'red', text: 'Not in Muse' };
    else if (hasMuse && hasHelcim) {
      if (delta < -100) flag = { cls: 'red', text: 'Helcim under Muse' };
      else if (rate != null) {
        const expected = Math.round(museCents * rate);
        const band = Math.max(100, Math.round(museCents * 0.01)); // ±$1 or 1% of the day
        if (Math.abs(delta - expected) > band) flag = { cls: 'amber', text: 'Surcharge off' };
      }
    }
    if (flag) flagCount++;
    return { date: day, museCents, musePending: !!m?.pending, helcimCents, hasMuse, hasHelcim, delta, flag };
  });
  return { rows, rate, totMuse, totHelcim, flagCount };
}
