// ── lib: match — suggest categories for staged bank rows (pure) ────────────────
// Priority: exact vendor match → keyword rule → "you approved this exact
// description before". AI (M7) slots in after these — rules always win.

export function normalizeDesc(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Whole-word (letter-bounded) match: is `term` present in `desc` as a complete LETTER run, not
// buried inside a bigger word? Digits and punctuation count as boundaries, so a jammed store
// number still matches ("arco914") but a fragment inside letters does not ("marco", "…baaaa…").
// Inputs are normalized (lowercased) so the [^a-z] boundary is correct. The compiled RegExp is
// cached per term; construction is wrapped so a pathological term can NEVER throw on the hot path
// (falls back to substring — escapeRegex already makes that path unreachable in practice). Rule
// keyword terms are a bounded set, but matchRank feeds the user's live SEARCH query in as a term,
// so the cache is size-capped (cleared wholesale past the cap) to stay bounded over a long session.
const _waCache = new Map();
const _WA_CACHE_MAX = 500;
export function wordAwareMatch(desc, term) {
  const t = normalizeDesc(term);
  if (!t) return false;
  let re = _waCache.get(t);
  if (re === undefined) {
    try { re = new RegExp('(^|[^a-z])' + escapeRegex(t) + '([^a-z]|$)', 'i'); } catch { re = null; }
    if (_waCache.size >= _WA_CACHE_MAX) _waCache.clear();
    _waCache.set(t, re);
  }
  const d = normalizeDesc(desc);
  return re ? re.test(d) : d.includes(t);
}

// Rank a candidate field against a query for search ordering: 3 exact · 2 whole-word · 1 partial
// (substring) · 0 none. Keeps partial matches (type-ahead) but sorts exact/word hits above them.
export function matchRank(field, query) {
  const f = normalizeDesc(field), q = normalizeDesc(query);
  if (!q || !f) return 0;
  if (f === q) return 3;
  if (wordAwareMatch(f, q)) return 2;
  if (f.includes(q)) return 1;
  return 0;
}

// row: {desc} · vendors: vendor entities · history: staged entities (any status)
// → { accountId, by:'rule'|'history', vendorId?, vendorName? } | null
export function suggestFor(row, { vendors = [], history = [] } = {}) {
  const desc = normalizeDesc(row.desc);
  if (!desc) return null;

  // Rules win over history. Among all vendors whose rule matches (category-less ones skipped so they
  // never block the row), the MOST SPECIFIC wins — see bestVendorMatch.
  const best = bestVendorMatch(row, vendors, true);
  if (best) return hit(best.vendor, 'rule');

  let recent = null;
  for (const h of history) {
    if (h.status !== 'approved' || !h.categoryId) continue;
    if (normalizeDesc(h.desc) === desc && (!recent || (h.updatedAt || 0) > (recent.updatedAt || 0))) recent = h;
  }
  if (recent) return { accountId: recent.categoryId, by: 'history' };
  return null;
}

const hit = (v, by) => ({ accountId: v.defaultAccountId, by, vendorId: v.id, vendorName: v.name });

// Find a vendor whose rule matches this row, IGNORING whether the vendor has a
// default account. Lets a "memorized vendor, no account" rule auto-fill the Vendor
// field even though it intentionally suggests no account. row: { desc, amountCents }.
export function vendorForRow(row, vendors = []) {
  const desc = normalizeDesc(row?.desc);
  if (!desc) return null;
  const best = bestVendorMatch(row, vendors, false);
  return best ? { vendorId: best.vendor.id, vendorName: best.vendor.name } : null;
}

// The most-specific vendor whose rule matches `row`. requireAccount → only vendors with a default
// account (suggestFor); false → any (vendorForRow's Vendor-field tagging). Specificity is
// lexicographic: higher TIER first (exact > any positive match > matched-only-by-negation), then the
// longest single matched term, then existing vendor order (stable — we replace only on strictly
// greater). Returns { vendor, tier, score } | null. Replaces the old "first vendor in array" so a
// short generic keyword ("arco") no longer beats a longer specific one ("bijan - american home…").
function bestVendorMatch(row, vendors, requireAccount) {
  let best = null;
  for (const v of vendors) {
    if (requireAccount && !v.defaultAccountId) continue;
    const s = matchStrength(v.matchers, row);
    if (!s) continue;
    if (!best || s.tier > best.tier || (s.tier === best.tier && s.score > best.score)) best = { vendor: v, tier: s.tier, score: s.score };
  }
  return best;
}

// Strength of a matchers object against a row = the strongest of its matched paths. tier 2 = exact
// match · 1 = any positive keyword/contains/starts/regex · 0 = matched ONLY via negation. score =
// length of the single longest positively-matched term (never a SUM — so a multi-keyword or OR rule
// can't inflate its specificity with branches that didn't match this row). null = no match.
function matchStrength(matchers, row) {
  const desc = normalizeDesc(row?.desc);
  if (!desc) return null;
  let tier = -1, score = 0;
  const bump = (t, s) => { if (t > tier || (t === tier && s > score)) { tier = t; score = s; } };
  // Legacy exact[]/keywords[] are scored ungated (no gateOk). Safe by construction: buildMatchers
  // only writes these arrays for UNRESTRICTED pure-OR rules (open gate), so a gated rule never carries
  // them. (Same ungated legacy path as the pre-refactor suggestFor.) The gate IS applied to the
  // conditions path below via matchesRule.
  for (const m of matchers?.exact || []) { const mm = normalizeDesc(m); if (mm && desc === mm) bump(2, mm.length); }
  for (const k of matchers?.keywords || []) { const kk = normalizeDesc(k); if (kk && wordAwareMatch(desc, kk)) bump(1, kk.length); }
  // Advanced conditions: must satisfy matchesRule (incl. the direction/amount gate); the score comes
  // from the strongest positive condition that itself matches — negation adds no positive specificity.
  if (matchesRule(matchers, row)) {
    const p = positiveConditionScore(matchers, row);
    if (p.tier >= 0) bump(p.tier, p.score); else bump(0, 0);
  }
  return tier < 0 ? null : { tier, score };
}

// The strongest POSITIVE condition (ignores not-contains) that individually matches this row. Uses
// matchCond as the SINGLE source of truth for whether a condition matches — so match semantics can
// never drift from matchesRule; only the length/tier is computed here. Conditions are scanned flat
// (not by and/or group): in a rare mixed AND/OR rule a positive condition whose own group didn't win
// can still contribute the score. That only tilts the specificity tie-break between competing rules
// (never whether a rule matches), and no live rule has that shape — acceptable.
function positiveConditionScore(matchers, row) {
  const desc = normalizeDesc(row?.desc), raw = row?.desc || '';
  let tier = -1, score = 0;
  const bump = (t, s) => { if (t > tier || (t === tier && s > score)) { tier = t; score = s; } };
  for (const c of matchers?.conditions || []) {
    const t = normalizeDesc(c?.text);
    if (!t || c.type === 'not-contains') continue;   // negation adds no positive specificity
    if (!matchCond(c, desc, raw)) continue;
    if (c.type === 'exact') bump(2, t.length);
    else if (c.type === 'regex') { try { const m = new RegExp(c.text, 'i').exec(raw); bump(1, ((m && m[0]) || '').length); } catch { bump(1, 0); } }
    else bump(1, t.length);   // 'contains' / 'starts'
  }
  return { tier, score };
}

// True when a row satisfies a matchers object's conditions AND its direction /
// amount-range gate. Conditions combine via per-condition and/or connectors with
// "and binds tighter than or": consecutive `and` conditions form a group, and the rule
// matches if ANY group matches. (A condition's `conn` is the operator joining it to the
// previous one; the first condition's is ignored. Missing conn = 'and' — legacy rules
// were ALL-of.) Pure — shared by suggestFor and the rule builder's live preview.
export function matchesRule(matchers, row) {
  const conds = matchers?.conditions;
  if (!Array.isArray(conds) || !conds.length) return false;
  const desc = normalizeDesc(row?.desc), raw = row?.desc || '';
  let result = false, group = true;
  for (let i = 0; i < conds.length; i++) {
    const m = matchCond(conds[i], desc, raw);
    if (i > 0 && conds[i].conn === 'or') { result = result || group; group = m; }
    else { group = i === 0 ? m : (group && m); }
  }
  if (!(result || group)) return false;
  return gateOk(matchers, row);
}
function matchCond(c, desc, rawDesc) {
  const t = normalizeDesc(c?.text);
  if (!t) return false;
  if (c.type === 'starts') return desc.startsWith(t);
  if (c.type === 'exact') return desc === t;
  // not-contains stays SUBSTRING on purpose: an exclusion guard must keep blocking glued variants
  // (e.g. "not-contains PRIME" must still exclude "PRIMEVIDEO"). Word-aware would weaken it.
  if (c.type === 'not-contains') return !desc.includes(t);
  if (c.type === 'regex') { try { return new RegExp(c.text, 'i').test(rawDesc); } catch { return false; } }
  return wordAwareMatch(desc, t);   // 'contains' (default) — whole-word, so "arco" no longer hits "marco"
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
