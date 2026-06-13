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
const daysBetween = (fromIso, toIso) =>
  Math.round((new Date(toIso + 'T12:00:00Z') - new Date(fromIso + 'T12:00:00Z')) / 86400000);

// Helcim dateClosed is "YYYY-MM-DD HH:MM:SS" (MT), or "0000-00-00 00:00:00" for an
// open batch → null. Returns the YYYY-MM-DD part, or null.
const batchClosedDate = (s) => {
  const d = String(s || '').slice(0, 10);
  return (/^\d{4}-\d{2}-\d{2}$/.test(d) && d !== '0000-00-00') ? d : null;
};

// Join Helcim card-transactions to their settlement batches. Transactions carry
// cardBatchId + amount + status/type; the batches list carries dateClosed (the
// API exposes NO batch amount — verified — so gross is summed here from APPROVED
// txns, refunds subtract). One row per batch with activity, oldest close first:
//   { batchId, batchNumber, dateClosed, grossCents, txnCount }
export function helcimBatchTotals(txns, batches) {
  const meta = new Map();
  for (const b of batches || []) {
    if (b && b.id != null) meta.set(String(b.id), { batchNumber: b.batchNumber ?? null, dateClosed: batchClosedDate(b.dateClosed) });
  }
  const byBatch = new Map();
  for (const t of txns || []) {
    if (String(t.status).toUpperCase() !== 'APPROVED') continue;
    if (t.cardBatchId == null) continue;
    const bid = String(t.cardBatchId);
    const cents = Math.round((Number(t.amount) || 0) * 100);
    const signed = String(t.type).toLowerCase() === 'refund' ? -cents : cents;
    const cur = byBatch.get(bid) || { grossCents: 0, txnCount: 0 };
    cur.grossCents += signed; cur.txnCount += 1;
    byBatch.set(bid, cur);
  }
  return [...byBatch.entries()].map(([batchId, v]) => ({
    batchId,
    batchNumber: meta.get(batchId)?.batchNumber ?? null,
    dateClosed: meta.get(batchId)?.dateClosed ?? null,
    grossCents: v.grossCents,
    txnCount: v.txnCount,
  })).sort((a, b) => (a.dateClosed || '').localeCompare(b.dateClosed || ''));
}

// Match a bank deposit to the settlement batch that explains it. The deposit is
// the NET; the batch gross is known; fee = gross − net must sit in
// [0, feeCapPct% + $1 slack]. The deposit lands 0..lookbackDays after the batch
// closed. Exact (fee 0 → Fee Saver) wins, then the smallest fee, then soonest.
// Returns the matched batch row + { feeCents, lagDays, exact }, or null.
export function matchDepositToBatch(deposit, batchTotals, { lookbackDays = 4, feeCapPct = 6 } = {}) {
  if (!deposit || !Number.isInteger(deposit.amountCents) || deposit.amountCents <= 0) return null;
  const net = deposit.amountCents;
  const candidates = [];
  for (const b of batchTotals || []) {
    if (!b.dateClosed || b.grossCents <= 0) continue;
    const lag = daysBetween(b.dateClosed, deposit.date);
    if (lag < 0 || lag > lookbackDays) continue;
    const fee = b.grossCents - net;
    if (fee < 0) continue;
    if (fee > Math.round(b.grossCents * feeCapPct / 100) + 100) continue;
    candidates.push({ ...b, feeCents: fee, lagDays: lag, exact: fee === 0 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.exact !== b.exact) ? (a.exact ? -1 : 1)
    : a.feeCents - b.feeCents || a.lagDays - b.lagDays);
  return candidates[0];
}

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
