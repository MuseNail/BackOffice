import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalAmountExpression } from '../js/app/calc.js';

test('left-to-right running evaluation (cash-register style)', () => {
  assert.equal(evalAmountExpression('40+5*2'), 90);   // (40+5)*2, not 40+(5*2)
  assert.equal(evalAmountExpression('40+5'), 45);
  assert.equal(evalAmountExpression('40-50'), -10);
  assert.equal(evalAmountExpression('12.50*2'), 25);
  assert.equal(evalAmountExpression('100/4'), 25);
});

test('rounds to cents; ÷ × glyphs normalize', () => {
  assert.equal(evalAmountExpression('100/3'), 33.33);
  assert.equal(evalAmountExpression('40×2'), 80);
  assert.equal(evalAmountExpression('90÷4'), 22.5);
});

test('plain numbers and junk return null (left untouched)', () => {
  assert.equal(evalAmountExpression('40'), null);
  assert.equal(evalAmountExpression('40.00'), null);
  assert.equal(evalAmountExpression(''), null);
  assert.equal(evalAmountExpression('abc'), null);
});

test('divide by zero leaves the accumulator (no Infinity)', () => {
  assert.equal(evalAmountExpression('50/0'), 50);
});
