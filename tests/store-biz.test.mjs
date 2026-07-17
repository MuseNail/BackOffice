// node --test tests/store-biz.test.mjs
// Layer 2 of the wrong-business-writes fix: the store tracks WHICH business the loaded state
// belongs to (stateBiz) — the PER-TAB routing authority dispatch reads first, so two tabs on
// different companies each route to their own. setSnapshot stamps it UNCONDITIONALLY so a
// no-arg call can never leave a stale-truthy value that would shadow the fallbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setSnapshot, setStateBiz, getStateBiz, getState } from '../js/app/store.js';

test('setSnapshot(snap, biz) stamps stateBiz and loads the state', () => {
  setSnapshot({ meta: { name: 'A' }, entities: { account: [{ id: 'x' }] }, seq: 5 }, 'biz-a');
  assert.equal(getStateBiz(), 'biz-a');
  assert.equal(getState().seq, 5);
  assert.equal(getState().entities.account[0].id, 'x');
});

test('setSnapshot with NO biz clears stateBiz to empty (never a stale-truthy value)', () => {
  setStateBiz('biz-a');
  setSnapshot({ entities: {}, seq: 1 });   // no biz arg (a test / legacy caller)
  assert.equal(getStateBiz(), '');         // fell back to '', not left as 'biz-a'
});

test('setStateBiz sets/clears the routing authority', () => {
  setStateBiz('biz-b'); assert.equal(getStateBiz(), 'biz-b');
  setStateBiz(''); assert.equal(getStateBiz(), '');
  setStateBiz(null); assert.equal(getStateBiz(), '');
  setStateBiz(undefined); assert.equal(getStateBiz(), '');
});

test('guard predicate: a late reply for a business the tab already left is discarded', () => {
  // openBusiness/resync apply a slow network reply ONLY when getStateBiz()===replyBiz — the
  // fix for the blocker where an A-reply arriving after a switch to B re-stamped the tab to A.
  setStateBiz('biz-b');                     // user switched to B
  const replyBiz = 'biz-a';                 // A's slow reply arrives now
  assert.equal(getStateBiz() === replyBiz, false);   // discarded → stateBiz stays B
  assert.equal(getStateBiz(), 'biz-b');
});
