// ── lib: sync-guards — pure decisions on the sync write path (no DOM / no IO) ──
// isRedundantWrite backs the auto-resolve of a stale rejection: a write the server refused as
// 'stale' but which is byte-identical to what the server already stored (a duplicate / out-of-order
// cross-tab send) can be DROPPED instead of dead-lettered into a permanent, un-clearable "Unsynced"
// badge. The whole safety of that drop rests on this comparison having ZERO false-positives — a write
// differing in ANY real field must compare unequal, so it is preserved (dead-lettered) exactly as
// before. decide409 turns a 409 rejection into the action flushOutbox takes. Both pure so they test.

// Deep structural equality: objects compared by key-set + per-key recurse (key-ORDER independent, so
// two identical writes serialized in different key order still match), arrays order-sensitive and
// length-checked. NaN is treated equal to itself (Object.is) so a NaN field can't force a false diff.
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// True only when `a` and `b` are the same entity in every field EXCEPT the two write stamps
// (updatedAt / updatedBy). Compare `a` = the outbox op's value, `b` = the server's stored copy
// (both JSON-normalized by the time this runs, so undefined-valued keys are already absent on both).
// Anything null/non-object, or any real field difference, ⇒ false (the safe, preserve-it direction).
export function isRedundantWrite(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const strip = (o) => { const { updatedAt, updatedBy, ...rest } = o; return rest; };
  return deepEqual(strip(a), strip(b));
}

// Classify a 409 rejection into the action flushOutbox should take:
//   'heal'          — a staged row advancing OUT of 'pending' that 409'd as stale on clock-skew:
//                     re-stamp once above the server's stamp and retry (bounded by op._healed).
//   'drop-redundant'— a stale write that is a proven content no-op vs the server's stored copy:
//                     drop it (the server already has it) instead of stranding a permanent badge.
//   'orphan'        — a wrong-business refusal: hold as an orphan for the recovery picker.
//   'deadletter'    — a genuine conflict / any other rejection: preserve it for recovery.
// `op` = the outbox op; `body` = the parsed 409 response ({ reason, storedUpdatedAt?, stored? }).
export function decide409(reason, op, body) {
  if (reason === 'stale') {
    const advancing = op && op.op === 'entity.upsert' && op.kind === 'staged'
      && op.value && op.value.status && op.value.status !== 'pending'
      && !op._healed && body && Number.isFinite(body.storedUpdatedAt);
    if (advancing) return 'heal';
    if (body && body.stored && isRedundantWrite(op && op.value, body.stored)) return 'drop-redundant';
    return 'deadletter';
  }
  if (reason === 'wrong-business') return 'orphan';
  return 'deadletter';
}
