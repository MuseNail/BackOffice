// ── lib: teller-map — Teller bank transactions → Back Office staged rows (pure) ─
// Teller's transaction `amount` is a signed decimal STRING ("-12.34"), negative =
// money out — the SAME sign convention Back Office uses for staged rows, so no
// inversion. We stage only POSTED transactions (pending ones can change amount or
// vanish before they settle, which would churn Review). The staged-row id is
// derived from Teller's stable transaction id so a re-sync is idempotent, and the
// dedupHash is the SAME content hash the CSV importer uses — so a Teller row and a
// hand-imported CSV row for the same transaction collapse to one. No DOM/IO.

import { dedupHash } from './csv.js';

// One Teller transaction → a staged-entity-shaped row, or null to skip it.
export function shapeTellerTxn(txn, bankacctId) {
  if (!txn || txn.status !== 'posted') return null;            // only settled rows reconcile
  const id = String(txn.id || '');
  if (!id) return null;
  const date = String(txn.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const desc = String(txn.description || '').replace(/\s+/g, ' ').trim();
  const cents = Math.round(parseFloat(txn.amount) * 100);
  if (!desc || !Number.isFinite(cents) || cents === 0) return null;
  return {
    id: 'tlr-' + id,
    importId: 'teller:' + (txn.account_id || bankacctId),
    bankacctId,
    date,
    desc,
    amountCents: cents,
    dedupHash: dedupHash({ date, desc, amountCents: cents }),
    source: { app: 'teller', sourceId: id },
    status: 'pending',
  };
}

// Batch: posted Teller txns → fresh staged rows, dropping any whose content hash is
// already staged for this account (a prior sync OR a CSV import of the same txn).
// knownHashes: Set of dedupHash already present for this bankacct.
export function shapeTellerBatch(txns, bankacctId, knownHashes = new Set()) {
  const out = [];
  const seen = new Set(knownHashes);
  for (const t of txns || []) {
    const row = shapeTellerTxn(t, bankacctId);
    if (!row) continue;
    if (seen.has(row.dedupHash)) continue;
    seen.add(row.dedupHash);
    out.push(row);
  }
  return out;
}
