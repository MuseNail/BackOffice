// node --test tests/posted-twin.test.mjs
// The Review "already posted (possible duplicate transfer)" check, extracted from a per-row scan of
// ALL transactions into a build-once index + O(1) lookup. Only TRANSFERS (a posted txn with two
// different bank/card lines) count — one bank line's (account, amount) can be the twin of a staged
// row on that account, within a few days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostedTwinIndex, findPostedTwin } from '../js/app/lib/posted-twin.js';

const BANKS = new Set(['chk', 'cc']);   // bank/card account ids
const T = (id, date, lines, status = 'posted') => ({ id, date, status, lines });

test('a posted transfer indexes BOTH bank sides; a staged row on either finds it within the window', () => {
  const txns = [T('t1', '2026-03-10', [{ accountId: 'chk', amountCents: -5000 }, { accountId: 'cc', amountCents: 5000 }])];
  const idx = buildPostedTwinIndex(txns, BANKS);
  // the checking side (−5000) and the card side (+5000) are both twinnable
  assert.equal(findPostedTwin(idx, 'chk', -5000, '2026-03-10', 3).id, 't1');
  assert.equal(findPostedTwin(idx, 'cc', 5000, '2026-03-12', 3).id, 't1');   // 2 days later, within window
  assert.equal(findPostedTwin(idx, 'chk', -5000, '2026-03-15', 3), null);    // 5 days — outside window
  assert.equal(findPostedTwin(idx, 'chk', -4000, '2026-03-10', 3), null);    // different amount
  assert.equal(findPostedTwin(idx, 'savings', -5000, '2026-03-10', 3), null); // different account
});

test('a NON-transfer (only one bank line) is not indexed — no false duplicate warning', () => {
  const txns = [T('e', '2026-03-10', [{ accountId: 'chk', amountCents: -5000 }, { accountId: 'supplies', amountCents: 5000 }])];
  const idx = buildPostedTwinIndex(txns, BANKS);
  assert.equal(findPostedTwin(idx, 'chk', -5000, '2026-03-10', 3), null);
});

test('staged / void / bad-date txns are ignored', () => {
  const twoBank = [{ accountId: 'chk', amountCents: -5000 }, { accountId: 'cc', amountCents: 5000 }];
  const idx = buildPostedTwinIndex([
    T('s', '2026-03-10', twoBank, 'staged'),
    T('v', '2026-03-10', twoBank, 'void'),
    T('b', 'not-a-date', twoBank),
  ], BANKS);
  assert.equal(findPostedTwin(idx, 'chk', -5000, '2026-03-10', 3), null);
});

test('findPostedTwin rejects a bad row date', () => {
  const idx = buildPostedTwinIndex([T('t', '2026-03-10', [{ accountId: 'chk', amountCents: -5000 }, { accountId: 'cc', amountCents: 5000 }])], BANKS);
  assert.equal(findPostedTwin(idx, 'chk', -5000, '', 3), null);
  assert.equal(findPostedTwin(idx, 'chk', -5000, 'bad', 3), null);
});

test('the index equals the old per-row scan for a mixed set (build-once == scan-each)', () => {
  const txns = [
    T('x1', '2026-03-01', [{ accountId: 'chk', amountCents: -100 }, { accountId: 'cc', amountCents: 100 }]),
    T('x2', '2026-03-02', [{ accountId: 'chk', amountCents: -200 }, { accountId: 'supplies', amountCents: 200 }]), // not a transfer
    T('x3', '2026-03-03', [{ accountId: 'cc', amountCents: -300 }, { accountId: 'chk', amountCents: 300 }]),
  ];
  const idx = buildPostedTwinIndex(txns, BANKS);
  // reference: the pre-extraction predicate
  const scan = (baId, amt, date) => txns.find(t => t.status === 'posted' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
    && Math.abs(new Date(t.date + 'T12:00:00') - new Date(date + 'T12:00:00')) <= 3 * 86400000
    && t.lines.some(l => l.accountId === baId && l.amountCents === amt)
    && t.lines.some(l => l.accountId !== baId && BANKS.has(l.accountId))) || null;
  for (const [baId, amt, date] of [['chk', -100, '2026-03-01'], ['chk', -200, '2026-03-02'], ['chk', 300, '2026-03-03'], ['cc', -300, '2026-03-03']]) {
    const a = findPostedTwin(idx, baId, amt, date, 3);
    assert.equal(a ? a.id : null, scan(baId, amt, date) ? scan(baId, amt, date).id : null, `${baId}/${amt}/${date}`);
  }
});
