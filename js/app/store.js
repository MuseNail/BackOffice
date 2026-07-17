// ── store — in-memory state for the ACTIVE business ────────────────
// Shape mirrors the DO snapshot: { meta, entities: {kind: [..]}, seq }.
// Mutate ONLY through applyChange (locally) / dispatch (synced).

let state = { meta: null, entities: {}, seq: 0 };
let rev = 0;
// The business the loaded state belongs to — the PER-TAB routing authority (dispatch reads it
// first). The shared bo_active_biz marker is last-tab-wins across tabs; this is module state, so
// each tab routes to its OWN company even with two open. The DO can't stamp its own id, so this
// is client-tracked from the bizId openBusiness fetched for — never derived from snapshot content.
let stateBiz = '';
const listeners = new Set();

export function getState() { return state; }
export function getRev() { return rev; }
export function getStateBiz() { return stateBiz; }
export function setStateBiz(biz) { stateBiz = biz || ''; }

export function setSnapshot(snap, biz) {
  state = { meta: snap.meta || null, entities: snap.entities || {}, seq: snap.seq || 0 };
  stateBiz = biz || '';   // UNCONDITIONAL: a no-arg call clears it so routing falls back safely, never a stale-truthy wrong value
  bump();
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function bump() {
  rev++;
  for (const fn of listeners) { try { fn(); } catch (e) { console.error('[store] listener', e); } }
}

export function entities(kind) { return state.entities[kind] || []; }
export function byId(kind, id) { return entities(kind).find(e => e.id === id); }

// Per-business capability flags (meta.features). When a flag is unset, derive it
// from existing data so businesses created before features existed behave correctly
// with no migration: a business with invoices/i2g mapping uses invoices; one with a
// Muse mapping or salon-synced rows uses Muse sync. An explicit flag always wins.
export function usesInvoices() {
  const f = state.meta?.features;
  if (f && typeof f.invoices === 'boolean') return f.invoices;
  return (state.entities.invoice?.length > 0) || !!state.meta?.i2gMapping;
}
export function usesMuseSync() {
  const f = state.meta?.features;
  if (f && typeof f.museSync === 'boolean') return f.museSync;
  return !!state.meta?.museMapping || (state.entities.staged || []).some(s => s.syncApp);
}

// Same op vocabulary as the DO — applied optimistically client-side.
export function applyChange(op) {
  if (op.op === 'meta.set') { state.meta = op.value; bump(); return; }
  if (op.op === 'entity.upsert') {
    const list = (state.entities[op.kind] ||= []);
    const i = list.findIndex(e => e.id === op.value.id);
    if (i >= 0) {
      // stale-write guard mirror: never let an older stamp clobber a newer one — EXCEPT a
      // staged row advancing out of 'pending' (approve/skip/match), a forward status
      // transition not a content race (mirrors business.js so optimistic + replay agree).
      const stagedAdvance = op.kind === 'staged' && list[i].status === 'pending'
        && op.value.status && op.value.status !== 'pending';
      if (!stagedAdvance && list[i].updatedAt && op.value.updatedAt && op.value.updatedAt < list[i].updatedAt) return;
      list[i] = op.value;
    } else list.push(op.value);
    bump(); return;
  }
  if (op.op === 'entity.bulkUpsert') {
    const list = (state.entities[op.kind] ||= []);
    for (const v of op.values || []) {
      if (!v?.id) continue;
      const i = list.findIndex(e => e.id === v.id);
      if (i >= 0) {
        if (list[i].updatedAt && v.updatedAt && v.updatedAt < list[i].updatedAt) continue;
        list[i] = v;
      } else list.push(v);
    }
    bump(); return;
  }
  if (op.op === 'entity.delete') {
    const list = state.entities[op.kind];
    if (list) {
      const i = list.findIndex(e => e.id === op.id);
      if (i >= 0) { list.splice(i, 1); bump(); }
    }
  }
}
