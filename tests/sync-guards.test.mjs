// node --test --test-force-exit tests/sync-guards.test.mjs
// Pure guards on the sync write path. isRedundantWrite decides whether a stale-refused write is a
// provable content no-op vs what the server already stored (so it can be DROPPED instead of stranding
// a permanent "Unsynced" badge). decide409 classifies a 409 rejection into the action flushOutbox takes.
// The entire safety of the auto-resolve rests on isRedundantWrite having ZERO false-positives — a write
// that differs in ANY real field must compare unequal so it is preserved, never dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRedundantWrite, decide409 } from '../js/app/lib/sync-guards.js';

// ── isRedundantWrite ────────────────────────────────────────────────────────
test('isRedundantWrite: identical except updatedAt/updatedBy ⇒ true (the incident shape)', () => {
  const a = { id: 't1', date: '2026-04-21', payee: 'Zelle to ShinyPawPrints', invoiceId: 'inv-4066',
    lines: [{ accountId: 'chk', amountCents: -158800 }, { accountId: 'ap', amountCents: 158800 }],
    status: 'posted', updatedAt: 1000, updatedBy: 'devA' };
  const b = { ...a, updatedAt: 1045, updatedBy: 'devA' };   // 45ms newer — the copy that landed
  assert.equal(isRedundantWrite(a, b), true);
});

test('isRedundantWrite: same content with REORDERED top-level keys ⇒ true (no JSON.stringify trap)', () => {
  const a = { id: 't1', payee: 'X', updatedAt: 1, lines: [{ accountId: 'c', amountCents: -5 }, { accountId: 'e', amountCents: 5 }] };
  const b = { lines: [{ accountId: 'c', amountCents: -5 }, { accountId: 'e', amountCents: 5 }], updatedAt: 9, payee: 'X', id: 't1' };
  assert.equal(isRedundantWrite(a, b), true);
});

test('isRedundantWrite: a nested line amount off by ONE cent ⇒ false', () => {
  const a = { id: 't1', lines: [{ accountId: 'c', amountCents: -5000 }, { accountId: 'e', amountCents: 5000 }], updatedAt: 1 };
  const b = { id: 't1', lines: [{ accountId: 'c', amountCents: -5001 }, { accountId: 'e', amountCents: 5001 }], updatedAt: 2 };
  assert.equal(isRedundantWrite(a, b), false);
});

test('isRedundantWrite: differing lines[] length ⇒ false', () => {
  const a = { id: 't1', lines: [{ accountId: 'c', amountCents: -5 }, { accountId: 'e', amountCents: 5 }], updatedAt: 1 };
  const b = { id: 't1', lines: [{ accountId: 'c', amountCents: -5 }, { accountId: 'e', amountCents: 3 }, { accountId: 'f', amountCents: 2 }], updatedAt: 2 };
  assert.equal(isRedundantWrite(a, b), false);
});

test('isRedundantWrite: an added/removed real field ⇒ false', () => {
  assert.equal(isRedundantWrite({ id: 't1', payee: 'X', updatedAt: 1 }, { id: 't1', updatedAt: 2 }), false);
  assert.equal(isRedundantWrite({ id: 't1', updatedAt: 1 }, { id: 't1', memo: 'note', updatedAt: 2 }), false);
});

test('isRedundantWrite: a changed payee/memo ⇒ false', () => {
  assert.equal(isRedundantWrite({ id: 't1', payee: 'X', updatedAt: 1 }, { id: 't1', payee: 'Y', updatedAt: 2 }), false);
});

test('isRedundantWrite: updatedBy is ignored, updatedAt is ignored, nothing else', () => {
  assert.equal(isRedundantWrite({ id: 't1', updatedAt: 1, updatedBy: 'a' }, { id: 't1', updatedAt: 2, updatedBy: 'b' }), true);
});

test('isRedundantWrite: null / non-object / one side missing ⇒ false (never drop on uncertainty)', () => {
  assert.equal(isRedundantWrite(null, { id: 't1' }), false);
  assert.equal(isRedundantWrite({ id: 't1' }, null), false);
  assert.equal(isRedundantWrite(undefined, undefined), false);
  assert.equal(isRedundantWrite('t1', 't1'), false);
  assert.equal(isRedundantWrite({ id: 't1', updatedAt: 1 }, undefined), false);
});

test('isRedundantWrite: nested object field differing ⇒ false; nested object identical ⇒ true', () => {
  assert.equal(isRedundantWrite({ id: 't1', meta: { a: 1 }, updatedAt: 1 }, { id: 't1', meta: { a: 2 }, updatedAt: 2 }), false);
  assert.equal(isRedundantWrite({ id: 't1', meta: { a: 1, b: 2 }, updatedAt: 1 }, { id: 't1', meta: { b: 2, a: 1 }, updatedAt: 2 }), true);
});

// ── decide409 ───────────────────────────────────────────────────────────────
const staleUpsert = (value) => ({ op: 'entity.upsert', kind: 'txn', value });

test('decide409: stale + a byte-identical stored copy ⇒ drop-redundant', () => {
  const op = staleUpsert({ id: 't1', payee: 'X', updatedAt: 1 });
  const body = { reason: 'stale', storedUpdatedAt: 2, stored: { id: 't1', payee: 'X', updatedAt: 2 } };
  assert.equal(decide409('stale', op, body), 'drop-redundant');
});

test('decide409: stale + a stored copy that DIFFERS ⇒ deadletter (preserve the conflict)', () => {
  const op = staleUpsert({ id: 't1', payee: 'X', updatedAt: 1 });
  const body = { reason: 'stale', storedUpdatedAt: 2, stored: { id: 't1', payee: 'Y', updatedAt: 2 } };
  assert.equal(decide409('stale', op, body), 'deadletter');
});

test('decide409: stale with NO stored (old Worker) ⇒ deadletter', () => {
  assert.equal(decide409('stale', staleUpsert({ id: 't1', updatedAt: 1 }), { reason: 'stale', storedUpdatedAt: 2 }), 'deadletter');
});

test('decide409: a staged row advancing out of pending ⇒ heal (takes priority over redundant)', () => {
  const op = { op: 'entity.upsert', kind: 'staged', value: { id: 'r1', status: 'approved', updatedAt: 1 } };
  assert.equal(decide409('stale', op, { reason: 'stale', storedUpdatedAt: 1000 }), 'heal');
});

test('decide409: a staged advance already healed once ⇒ NOT heal again', () => {
  const op = { op: 'entity.upsert', kind: 'staged', _healed: true, value: { id: 'r1', status: 'approved', updatedAt: 1 } };
  assert.equal(decide409('stale', op, { reason: 'stale', storedUpdatedAt: 1000 }), 'deadletter');
});

test('decide409: a staged advance with no finite storedUpdatedAt ⇒ NOT heal', () => {
  const op = { op: 'entity.upsert', kind: 'staged', value: { id: 'r1', status: 'approved', updatedAt: 1 } };
  assert.equal(decide409('stale', op, { reason: 'stale' }), 'deadletter');
});

test('decide409: a staged row STAYING pending is not an advance ⇒ classified by redundancy', () => {
  const op = { op: 'entity.upsert', kind: 'staged', value: { id: 'r1', status: 'pending', desc: 'old', updatedAt: 1 } };
  assert.equal(decide409('stale', op, { reason: 'stale', storedUpdatedAt: 2, stored: { id: 'r1', status: 'pending', desc: 'new', updatedAt: 2 } }), 'deadletter');
});

test('decide409: wrong-business ⇒ orphan', () => {
  assert.equal(decide409('wrong-business', staleUpsert({ id: 't1' }), { reason: 'wrong-business' }), 'orphan');
});

test('decide409: any other reason ⇒ deadletter', () => {
  assert.equal(decide409('reconciled: amounts and accounts are locked', staleUpsert({ id: 't1' }), {}), 'deadletter');
  assert.equal(decide409('rejected', staleUpsert({ id: 't1' }), {}), 'deadletter');
  assert.equal(decide409('period 2026-04 is locked', staleUpsert({ id: 't1' }), {}), 'deadletter');
});
