// ── lib: orphan-recovery — pure helpers for the "never guess a write's business" path ──
// Layer 1 of the wrong-business-writes fix. A write the app couldn't tag with a business
// (an "orphan") must never be GUESSED into whatever books are open — a wrong guess posted a
// $4,000 TIE Corp txn into Muse's ledger. Instead it's held in the dead-letter log and the
// owner files it by hand. These two pure helpers back that flow; no DOM / no IO so they test.

// A human-readable summary of a queued write op, for the recovery UI. Structured (not a
// string) so the caller formats money in the app's own style. A txn shows date · payee ·
// amount (the largest-magnitude line — the bank line, or the sum the split balances to);
// anything else gets a plain op/kind/id fallback. Never throws on a malformed op.
export function describeWrite(op) {
  if (!op || typeof op !== 'object') return { fallback: 'unknown write' };
  const kind = op.kind || '';
  const v = op.value || {};
  if (op.op === 'entity.upsert' && kind === 'txn') {
    let cents = 0;
    if (Array.isArray(v.lines)) {
      for (const l of v.lines) {
        const c = (l && Number.isFinite(l.amountCents)) ? l.amountCents : 0;
        if (Math.abs(c) > Math.abs(cents)) cents = c;
      }
    }
    return { kind: 'txn', date: v.date || '', payee: v.payee || v.memo || '', cents: Math.abs(cents) };
  }
  const id = v.id || op.id || '';
  return { fallback: `${op.op || 'write'} ${kind}${id ? ' ' + id : ''}`.trim() };
}

// Split the dead-letter log into writes that still know their business (safe to re-queue on
// "Sync now") and orphans that don't (must stay put for the owner to file — re-queuing an
// orphan would dead-letter it again → a loop + a serious-error push per tap). A null/blank
// biz is an orphan.
export function partitionFailed(failed) {
  const list = Array.isArray(failed) ? failed : [];
  return { routable: list.filter(f => f && f.biz), orphans: list.filter(f => !f || !f.biz) };
}

// syncNow's transform: move failed writes that still know their business back onto the outbox
// TAIL (oldest-first — the failed log is newest-first — stripped of the one-shot `_healed`
// retry flag), leaving orphans in the failed log. Pure so the money-safety property — an
// orphan is NEVER re-queued (it would dead-letter again → loop + a push per tap) — is pinned
// by a test. `moved` = how many routable writes were re-queued (0 ⇒ the caller skips the write).
export function requeueRoutable(failed, outbox) {
  const { routable, orphans } = partitionFailed(failed);
  const requeued = routable.slice().reverse().map(f => { const op = { ...f.op }; delete op._healed; return { biz: f.biz, op }; });
  return { outbox: (Array.isArray(outbox) ? outbox.slice() : []).concat(requeued), failed: orphans, moved: routable.length };
}
