// node --test tests/features.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setSnapshot, usesInvoices, usesMuseSync } from '../js/app/store.js';

const snap = (meta = {}, entities = {}) => ({ meta, entities, seq: 0 });

test('usesInvoices: an explicit flag always wins over the data', () => {
  setSnapshot(snap({ features: { invoices: true } }, { invoice: [] }));
  assert.equal(usesInvoices(), true, 'explicit true with no invoice data');
  setSnapshot(snap({ features: { invoices: false } }, { invoice: [{ id: 'i1' }] }));
  assert.equal(usesInvoices(), false, 'explicit false even with invoice data');
});

test('usesInvoices: derives from existing data when the flag is unset', () => {
  setSnapshot(snap({}, { invoice: [{ id: 'i1' }] }));
  assert.equal(usesInvoices(), true, 'has invoice entities');
  setSnapshot(snap({ i2gMapping: { incomeId: 'x' } }, {}));
  assert.equal(usesInvoices(), true, 'has an Invoice2go mapping');
  setSnapshot(snap({}, {}));
  assert.equal(usesInvoices(), false, 'no invoice data at all');
});

test('usesMuseSync: an explicit flag always wins over the data', () => {
  setSnapshot(snap({ features: { museSync: false }, museMapping: { balancing: {} } }, {}));
  assert.equal(usesMuseSync(), false, 'explicit false even with a Muse mapping');
  setSnapshot(snap({ features: { museSync: true } }, {}));
  assert.equal(usesMuseSync(), true, 'explicit true with no Muse data');
});

test('usesMuseSync: derives from existing data when the flag is unset', () => {
  setSnapshot(snap({ museMapping: { balancing: {} } }, {}));
  assert.equal(usesMuseSync(), true, 'has a Muse mapping (the existing salon)');
  setSnapshot(snap({}, { staged: [{ id: 's1', syncApp: 'musenail' }] }));
  assert.equal(usesMuseSync(), true, 'has salon-synced staged rows');
  setSnapshot(snap({}, { staged: [{ id: 's2' }] }));
  assert.equal(usesMuseSync(), false, 'staged rows but none from the salon');
});
