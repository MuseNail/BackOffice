// ── lib: processor-match — match a bank deposit to processor daily sales ───────
// (M13) A processor payout lands at the bank 1–4 business days after the sales
// day(s) it covers, net of fees. Given per-day gross activity — from EITHER the
// ledger's clearing-account debits (the Muse sync posts those) OR Helcim's
// card-transactions API — find the day window whose gross explains the deposit
// and surface the implied processing fee. Pure functions, no DOM/IO.

// Helcim list-transactions rows → per-day gross totals. dateCreated is
// "YYYY-MM-DD HH:MM:SS" in MOUNTAIN TIME (verified, HELCIM-MIGRATION.md) — we
// group by its date part as-is; the window search absorbs the ±1-day skew vs
// the salon's local calendar. Approved purchases add, approved refunds subtract.
export function helcimDayTotals(txns) {
  const byDay = new Map();
  for (const t of txns || []) {
    if (String(t.status).toUpperCase() !== 'APPROVED') continue;
    const day = String(t.dateCreated || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const cents = Math.round((Number(t.amount) || 0) * 100);
    const signed = String(t.type).toLowerCase() === 'refund' ? -cents : cents;
    byDay.set(day, (byDay.get(day) || 0) + signed);
  }
  return [...byDay.entries()].map(([date, grossCents]) => ({ date, grossCents })).sort((a, b) => a.date.localeCompare(b.date));
}

// Ledger view of the same thing: per-day DEBITS into the clearing account(s)
// the synced sales rows hit (positive lines only — the deposit transfers we're
// about to post are credits and must not feed back into the totals).
export function ledgerDayDebits(txns, accountIds) {
  const ids = new Set(accountIds || []);
  const byDay = new Map();
  for (const t of txns || []) {
    if (t.status !== 'posted') continue;
    for (const l of t.lines || []) {
      if (ids.has(l.accountId) && l.amountCents > 0) byDay.set(t.date, (byDay.get(t.date) || 0) + l.amountCents);
    }
  }
  return [...byDay.entries()].map(([date, grossCents]) => ({ date, grossCents })).sort((a, b) => a.date.localeCompare(b.date));
}

const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Find the consecutive-day window (1..maxDays) ending 0..lookbackDays before the
// deposit whose gross best explains it: fee = gross − net must sit in
// [0, feeCapPct% + perTxnSlackCents]. Exact (fee 0, e.g. Helcim Fee Saver) wins,
// then the smallest plausible fee. Returns null when nothing fits.
export function matchDeposit(deposit, dayTotals, { lookbackDays = 6, maxDays = 3, feeCapPct = 6 } = {}) {
  if (!deposit || !Number.isInteger(deposit.amountCents) || deposit.amountCents <= 0) return null;
  const net = deposit.amountCents;
  const byDate = new Map((dayTotals || []).map(d => [d.date, d.grossCents]));
  const candidates = [];
  for (let back = 0; back <= lookbackDays; back++) {
    const end = addDays(deposit.date, -back);
    for (let span = 1; span <= maxDays; span++) {
      const days = Array.from({ length: span }, (_, i) => addDays(end, -i)).reverse();
      if (!days.some(d => byDate.has(d))) continue;
      const gross = days.reduce((s, d) => s + (byDate.get(d) || 0), 0);
      const fee = gross - net;
      if (fee < 0) continue;
      if (fee > Math.round(gross * feeCapPct / 100) + 100) continue;
      candidates.push({ days, grossCents: gross, feeCents: fee, exact: fee === 0 });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.exact !== b.exact) ? (a.exact ? -1 : 1)
    : a.feeCents - b.feeCents || a.days.length - b.days.length);
  return candidates[0];
}
