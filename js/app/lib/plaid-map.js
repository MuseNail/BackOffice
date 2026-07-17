// ── lib: plaid-map — Plaid bank transactions → Back Office staged rows (pure) ───
// Plaid's `amount` is a NUMBER and POSITIVE means money LEAVING the account (an
// outflow) — the OPPOSITE of Back Office (and of bank CSVs), where negative = out.
// So we FLIP the sign. We stage only settled rows (`pending === false`); the
// staged-row id is derived from Plaid's stable transaction_id so a re-sync is
// idempotent. The dedupHash is the SAME content hash the CSV importer uses, so a CSV
// import checks itself against Plaid rows already staged (banking.js) — but NOT the
// reverse: routes/plaid.js calls shapePlaidBatch without knownHashes, so a Plaid row
// and an existing CSV row for the same transaction both survive. Don't read the
// knownHashes parameter as a guarantee the sync path makes; today nothing passes it.
// `/transactions/sync` returns added/modified/removed arrays of these objects. No DOM/IO.

import { dedupHash } from './csv.js';

// One Plaid transaction → a staged-entity-shaped row, or null to skip it.
export function shapePlaidTxn(txn, bankacctId) {
  if (!txn || txn.pending === true) return null;               // only settled rows reconcile
  const id = String(txn.transaction_id || '');
  if (!id) return null;
  const date = String(txn.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const desc = String(txn.name || '').replace(/\s+/g, ' ').trim();   // raw bank description, like the CSV
  const cents = -Math.round(Number(txn.amount) * 100);          // FLIP: Plaid +out → BO −out
  if (!desc || !Number.isFinite(cents) || cents === 0) return null;
  return {
    id: 'plaid-' + id,
    importId: 'plaid:' + (txn.account_id || bankacctId),
    bankacctId,
    date,
    desc,
    amountCents: cents,
    dedupHash: dedupHash({ date, desc, amountCents: cents }),
    source: { app: 'plaid', sourceId: id },
    status: 'pending',
  };
}

// Batch: settled Plaid txns → fresh staged rows, dropping any whose content hash is
// already staged for this account (a prior sync OR a CSV import of the same txn).
// knownHashes: Set of dedupHash already present for this bankacct.
export function shapePlaidBatch(txns, bankacctId, knownHashes = new Set()) {
  const out = [];
  const seen = new Set(knownHashes);
  for (const t of txns || []) {
    const row = shapePlaidTxn(t, bankacctId);
    if (!row) continue;
    if (seen.has(row.dedupHash)) continue;
    seen.add(row.dedupHash);
    out.push(row);
  }
  return out;
}
