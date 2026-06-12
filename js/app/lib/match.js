// ── lib: match — suggest categories for staged bank rows (pure) ────────────────
// Priority: exact vendor match → keyword rule → "you approved this exact
// description before". AI (M7) slots in after these — rules always win.

export function normalizeDesc(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// row: {desc} · vendors: vendor entities · history: staged entities (any status)
// → { accountId, by:'rule'|'history', vendorId?, vendorName? } | null
export function suggestFor(row, { vendors = [], history = [] } = {}) {
  const desc = normalizeDesc(row.desc);
  if (!desc) return null;

  // a rule missing its category is skipped entirely — it must never block the
  // matchers (or the history fallback) behind it
  for (const v of vendors) {
    if (!v.defaultAccountId) continue;
    for (const m of v.matchers?.exact || []) {
      if (desc === normalizeDesc(m)) return hit(v, 'rule');
    }
  }
  for (const v of vendors) {
    if (!v.defaultAccountId) continue;
    for (const k of v.matchers?.keywords || []) {
      const kk = normalizeDesc(k);
      if (kk && desc.includes(kk)) return hit(v, 'rule');
    }
  }

  let best = null;
  for (const h of history) {
    if (h.status !== 'approved' || !h.categoryId) continue;
    if (normalizeDesc(h.desc) === desc && (!best || (h.updatedAt || 0) > (best.updatedAt || 0))) best = h;
  }
  if (best) return { accountId: best.categoryId, by: 'history' };
  return null;
}

const hit = (v, by) => ({ accountId: v.defaultAccountId, by, vendorId: v.id, vendorName: v.name });

// "SALLY BEAUTY, #10382" → "Sally Beauty" — a human-looking vendor-name guess
// for prefilling the make-a-rule form.
export function guessVendorName(desc) {
  const words = String(desc || '').replace(/[",]/g, ' ').split(/\s+/)
    .filter(w => w && !/^[#\d*-]+$/.test(w) && !/^x{2,}\d*$/i.test(w));
  return words.slice(0, 3).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
