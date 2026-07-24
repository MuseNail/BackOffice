// node --test --test-force-exit tests/ui-append.test.mjs
// appendKids appends children to a real DOM node while skipping nullish ones — the fix for native
// Node.append(null) rendering the visible text "null". Verified with a fake node (no jsdom needed):
// the modals only ever pass element nodes or null, so the createTextNode branch isn't exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendKids } from '../js/app/ui.js';

test('appendKids skips null and undefined children (native .append would render "null")', () => {
  const got = [];
  const node = { append(x) { got.push(x); } };
  const a = { nodeType: 1 }, b = { nodeType: 1 };
  const ret = appendKids(node, a, null, b, undefined);
  assert.deepEqual(got, [a, b], 'only the real nodes are appended');
  assert.equal(ret, node, 'returns the node for chaining, like el/clear');
});

test('appendKids flattens a child array and still skips nullish', () => {
  const got = [];
  const node = { append(x) { got.push(x); } };
  const a = { nodeType: 1 }, b = { nodeType: 1 };
  appendKids(node, [a, null, b]);
  assert.deepEqual(got, [a, b]);
});

test('appendKids appends element nodes untouched (never coerced to text)', () => {
  const got = [];
  const node = { append(x) { got.push(x); } };
  const only = { nodeType: 1, tag: 'p' };
  appendKids(node, only);
  assert.equal(got[0], only);
});
