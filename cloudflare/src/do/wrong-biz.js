// ── wrong-biz — the Layer-3 seal check (SYNC-MISROUTE-PLAN.md) ──
// A client write carries `op._sealBiz`: the business whose books were LOADED in the tab
// when the write was made (stamped at dispatch from getStateBiz() — data-derived, never
// the routing fallback chain, which is exactly the guess this check exists to catch). The
// Worker stamps every /b/<biz>/* forward with an unspoofable X-Bo-Biz header from the URL
// path. If both exist and disagree, the write was re-routed AFTER it was made — refuse it
// rather than post it into another company's ledger. Both-present-required means
// server-built internal ops (no seal) and internal DO callers (no expectedBiz) skip by
// design, and pre-L3 clients are unaffected.
export function wrongBusiness(op, expectedBiz) {
  return !!(op && op._sealBiz && expectedBiz && op._sealBiz !== expectedBiz);
}
