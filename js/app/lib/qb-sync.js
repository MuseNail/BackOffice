// ── lib: qb-sync — one-way "keep QuickBooks Desktop matching the app" diff (pure) ──
// The app is the source of truth for the chart of accounts and the vendor list; this
// figures out what QuickBooks needs so it matches EXACTLY. IIF list import matches by
// NAME, so it handles creates + field updates on its own — but it physically cannot
// rename, merge, or inactivate a list entry. So we keep a SNAPSHOT of what we last
// pushed (keyed by each item's stable app id) and diff the current state against it:
// a changed name on the same id is a RENAME (not a delete+create), an archived id is
// an ARCHIVE, an id that merged into another is a MERGE — each surfaced as a manual
// step. Vendors are removed outright when merged/deleted, so those show as "removed".
import { qbAccountName, qbTypeFor } from './qb-iif.js';

// The QB-facing name of an account = qbAccountName (qbName || name, with Parent:Child) —
// the SAME name the transaction export uses, so the two never disagree in QuickBooks.
export { qbAccountName } from './qb-iif.js';

// Snapshot of what we last told QB, keyed by stable app id. Includes archived items so
// the next diff can see "was active, now archived". Caller stamps a timestamp on save.
export function qbSyncSnapshot(accounts, vendors) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const acc = {};
  for (const a of accounts) acc[a.id] = { name: qbAccountName(a, byId), type: qbTypeFor(a), active: a.active !== false, mergedInto: a.mergedInto || null };
  const ven = {};
  for (const v of vendors) ven[v.id] = { name: (v.name || '').trim(), active: v.active !== false };
  return { accounts: acc, vendors: ven };
}

// Classify every change since `baseline` (null = never synced → everything is a create).
// Returns plain arrays the UI renders: creates are handled by the IIF file; renames /
// merges / archives / type-changes are the manual checklist IIF can't express.
export function qbSyncDiff(baseline, accounts, vendors) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const base = baseline || { accounts: {}, vendors: {} };
  const out = {
    firstSync: !baseline,
    accounts: { creates: [], renames: [], typeChanges: [], merges: [], archives: [] },
    vendors: { creates: [], renames: [], removed: [] },
  };

  for (const a of accounts) {
    const cur = { name: qbAccountName(a, byId), type: qbTypeFor(a), active: a.active !== false, mergedInto: a.mergedInto || null };
    const prev = base.accounts[a.id];
    if (!prev) { if (cur.active) out.accounts.creates.push(cur.name); continue; }
    if (prev.active && !cur.active) {
      if (cur.mergedInto) {
        const t = byId.get(cur.mergedInto);
        out.accounts.merges.push({ from: prev.name, into: t ? qbAccountName(t, byId) : cur.mergedInto });
      } else out.accounts.archives.push(prev.name);
      continue;
    }
    if (!cur.active) continue;                         // already inactive at last sync
    if (cur.name !== prev.name) out.accounts.renames.push({ from: prev.name, to: cur.name });
    if (cur.type !== prev.type) out.accounts.typeChanges.push({ name: cur.name, from: prev.type, to: cur.type });
  }

  const venIds = new Set(vendors.map(v => v.id));
  for (const v of vendors) {
    const cur = { name: (v.name || '').trim(), active: v.active !== false };
    const prev = base.vendors[v.id];
    if (!prev) { if (cur.active) out.vendors.creates.push(cur.name); continue; }
    if (prev.active && !cur.active) { out.vendors.removed.push(prev.name); continue; }
    if (!cur.active) continue;
    if (cur.name !== prev.name) out.vendors.renames.push({ from: prev.name, to: cur.name });
  }
  // A vendor in the baseline but gone now was merged or deleted in the app.
  for (const id of Object.keys(base.vendors)) {
    if (!venIds.has(id) && base.vendors[id].active) out.vendors.removed.push(base.vendors[id].name);
  }
  return out;
}

// Totals for a one-line summary; manual = the count of things needing a hand in QB.
export function qbSyncCounts(diff) {
  const a = diff.accounts, v = diff.vendors;
  return {
    creates: a.creates.length + v.creates.length,
    manual: a.renames.length + a.merges.length + a.archives.length + a.typeChanges.length + v.renames.length + v.removed.length,
  };
}
