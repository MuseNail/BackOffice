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
  // Advanced conditions (v0.68.7+): match-type per condition (contains/starts/exact/
  // regex), ALL must match, plus an optional direction / amount-range gate. Legacy
  // exact[]/keywords[] above stay so old rules and not-yet-updated devices keep working.
  for (const v of vendors) {
    if (!v.defaultAccountId) continue;
    if (matchesRule(v.matchers, row)) return hit(v, 'rule');
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

// Find a vendor whose rule matches this row, IGNORING whether the vendor has a
// default account. Lets a "memorized vendor, no account" rule auto-fill the Vendor
// field even though it intentionally suggests no account. row: { desc, amountCents }.
export function vendorForRow(row, vendors = []) {
  const desc = normalizeDesc(row?.desc);
  if (!desc) return null;
  for (const v of vendors) {
    if ((v.matchers?.exact || []).some(m => desc === normalizeDesc(m))) return { vendorId: v.id, vendorName: v.name };
  }
  for (const v of vendors) {
    if ((v.matchers?.keywords || []).some(k => { const kk = normalizeDesc(k); return kk && desc.includes(kk); })) return { vendorId: v.id, vendorName: v.name };
  }
  for (const v of vendors) {
    if (matchesRule(v.matchers, row)) return { vendorId: v.id, vendorName: v.name };
  }
  return null;
}

// True when a row satisfies a matchers object's advanced conditions (ALL of them)
// AND its direction / amount-range gate. Pure — shared by suggestFor and the rule
// builder's live preview. row: { desc, amountCents }.
export function matchesRule(matchers, row) {
  const conds = matchers?.conditions;
  if (!Array.isArray(conds) || !conds.length) return false;
  const desc = normalizeDesc(row?.desc);
  if (!conds.every(c => matchCond(c, desc, row?.desc || ''))) return false;
  return gateOk(matchers, row);
}
function matchCond(c, desc, rawDesc) {
  const t = normalizeDesc(c?.text);
  if (!t) return false;
  if (c.type === 'starts') return desc.startsWith(t);
  if (c.type === 'exact') return desc === t;
  if (c.type === 'not-contains') return !desc.includes(t);
  if (c.type === 'regex') { try { return new RegExp(c.text, 'i').test(rawDesc); } catch { return false; } }
  return desc.includes(t);   // 'contains' (default)
}
function gateOk(m, row) {
  const amt = row?.amountCents || 0, abs = Math.abs(amt);
  const dir = m.direction || 'any';
  if (dir === 'in' && amt <= 0) return false;
  if (dir === 'out' && amt >= 0) return false;
  if (m.amountMin != null && abs < m.amountMin) return false;
  if (m.amountMax != null && abs > m.amountMax) return false;
  return true;
}

// "SALLY BEAUTY, #10382" → "Sally Beauty" — a human-looking vendor-name guess
// for prefilling the make-a-rule form.
export function guessVendorName(desc) {
  const words = String(desc || '').replace(/[",]/g, ' ').split(/\s+/)
    .filter(w => w && !/^[#\d*-]+$/.test(w) && !/^x{2,}\d*$/i.test(w));
  return words.slice(0, 3).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
