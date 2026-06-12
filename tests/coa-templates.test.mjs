// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { INDUSTRIES, coaFor, industryLabel, ACCOUNT_TYPES, QB_TYPES } from '../js/app/lib/coa-templates.js';

test('every industry yields a valid, unique, complete COA', () => {
  const TYPES = new Set(ACCOUNT_TYPES);
  const QB = new Set(QB_TYPES);
  for (const ind of INDUSTRIES) {
    const coa = coaFor(ind.id);
    assert.ok(coa.length >= 15, `${ind.id} has a real starting set`);
    const ids = new Set(coa.map(a => a.id));
    assert.equal(ids.size, coa.length, `${ind.id} ids are unique`);
    for (const a of coa) {
      assert.ok(a.id && a.name && a.qbName, `${ind.id}/${a.id} named`);
      assert.ok(TYPES.has(a.type), `${ind.id}/${a.id} valid type ${a.type}`);
      assert.ok(QB.has(a.qbType), `${ind.id}/${a.id} valid qbType ${a.qbType}`);
      assert.equal(a.active, true);
    }
    assert.ok(coa.some(a => a.type === 'income'), `${ind.id} has income`);
    assert.ok(coa.some(a => a.type === 'expense'), `${ind.id} has expenses`);
    assert.ok(coa.some(a => a.qbType === 'BANK'), `${ind.id} has a bank account`);
    assert.ok(coa.some(a => a.type === 'equity'), `${ind.id} has equity`);
  }
});

test('unknown industry falls back to general', () => {
  assert.deepEqual(coaFor('nonsense').map(a => a.id), coaFor('general').map(a => a.id));
});

test('coaFor returns fresh copies, not shared references', () => {
  const a = coaFor('retail');
  a[0].name = 'MUTATED';
  assert.notEqual(coaFor('retail')[0].name, 'MUTATED');
});

test('industryLabel resolves and falls through', () => {
  assert.equal(industryLabel('salon-spa'), 'Salon / Spa');
  assert.equal(industryLabel('zzz'), 'zzz');
});
