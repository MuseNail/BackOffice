// ── audit — append-only activity trail ─────────────────────────────────────────
// logAudit() records a consequential change as a synced `audit` entity so the
// Activity view shows who did what and when, on every device. Entries are never
// edited or deleted by the app — it's a trail, not a working set. (The Worker must
// list 'audit' in ENTITY_KINDS for these to sync; until then they dead-letter.)
import { dispatch } from './sync.js';
import { getUser } from './session.js';

let _seq = 0;

// action: short verb-ish key ('post' | 'edit' | 'void' | 'delete' | 'reconcile' |
//   'rule' | 'account'). detail: { summary, kind, entityId, amountCents }.
export function logAudit(action, detail = {}) {
  const u = getUser();
  const id = 'aud-' + Date.now().toString(36) + '-' + (_seq++).toString(36) + Math.random().toString(36).slice(2, 5);
  dispatch({ op: 'entity.upsert', kind: 'audit', value: {
    id,
    ts: Date.now(),
    action,
    user: u?.name || '—',
    userId: u?.id || '',
    summary: detail.summary || '',
    kind: detail.kind || '',
    entityId: detail.entityId || '',
    amountCents: typeof detail.amountCents === 'number' ? detail.amountCents : undefined,
  } });
}
