// ── lib: review-source — classify a staged row's suggestion SOURCE (pure) ──────
// The Review screen shows a per-row chip for WHERE a suggestion came from, and (v0.71.11) a
// filter to view by source. Both MUST agree, so the resolution lives here, once, and
// reproduces review.js rowCard EXACTLY: suggestFor → null a missing/inactive account → fold
// in the AI suggestion → derive the vendor tag / AI-vendor prefill. No DOM/IO ⇒ testable.
import { suggestFor, vendorForRow } from './match.js';

// icon + label + pill colour token per source. ONE definition the chip and the filter read.
export const SOURCE_META = {
  client:        { icon: '💬', label: 'Client suggested', cls: 'blue' },
  rule:          { icon: '⚡', label: 'Rule',             cls: 'blue' },
  ai:            { icon: '✨', label: 'AI',               cls: 'amber' },
  history:       { icon: '🕘', label: 'Seen before',      cls: 'green' },
  'vendor-rule': { icon: '⚡', label: 'Rule',             cls: 'blue' },
  'ai-vendor':   { icon: '✨', label: 'AI',               cls: 'amber' },
  none:          { icon: '◻', label: 'No suggestion',    cls: 'gray' },
};

// row: a staged row · vendors/history: match context · accountsById: Map(id → account) ·
// aiSug: aiSuggestions.get(row.id) | null.
// → { sug, vendorTag, vendPrefillText, source } — `source` ∈ SOURCE_META keys.
export function resolveRowSuggestion(row, { vendors = [], history = [], accountsById = new Map(), aiSug = null } = {}) {
  // A client's proposed split is its own (client) card upstream — classify it as client here
  // so the filter buckets it with the other client suggestions.
  if (row && Array.isArray(row.suggestedSplit) && row.suggestedSplit.length >= 2) {
    return { sug: null, vendorTag: null, vendPrefillText: '', source: 'client' };
  }
  const validAcct = (id) => accountsById.has(id) && accountsById.get(id).active !== false;

  let sug = suggestFor(row, { vendors, history });
  if (sug && !validAcct(sug.accountId)) sug = null;   // a suggestion into a missing/archived account is not usable
  if (!sug && aiSug?.accountId && validAcct(aiSug.accountId)) sug = { accountId: aiSug.accountId, by: 'ai', confidence: aiSug.confidence };

  // A vendor rule with no account still tags the vendor (pick the account yourself).
  let vendorTag = sug?.vendorId ? { vendorId: sug.vendorId, vendorName: sug.vendorName } : vendorForRow(row, vendors);
  let vendPrefillText = '';
  if (!vendorTag && aiSug?.vendorName) {
    const match = vendors.find(v => (v.name || '').toLowerCase() === aiSug.vendorName.toLowerCase());
    if (match) vendorTag = { vendorId: match.id, vendorName: match.name };
    else vendPrefillText = aiSug.vendorName;
  }

  const source = row?.suggestedAt ? 'client'
    : sug ? (sug.by === 'rule' ? 'rule' : sug.by === 'ai' ? 'ai' : 'history')
    : vendorTag ? 'vendor-rule'
    : vendPrefillText ? 'ai-vendor'
    : 'none';
  return { sug, vendorTag, vendPrefillText, source };
}

// Filter predicate: the user-facing buckets fold the two "pick an account yourself" variants
// in with their parent (a vendor-rule reads as a Rule; an ai-vendor reads as AI).
export function sourceMatches(filterVal, source) {
  if (!filterVal || filterVal === 'all') return true;
  if (filterVal === 'rule') return source === 'rule' || source === 'vendor-rule';
  if (filterVal === 'ai') return source === 'ai' || source === 'ai-vendor';
  return source === filterVal;
}
