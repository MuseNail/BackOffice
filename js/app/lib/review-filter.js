// ── lib: review-filter — pure helpers for the Review filter bar ────────────────
// The filter bar collapses behind a "Filters" button when the Review window is narrow.
// activeFilterCount feeds the button's badge (so hidden filters stay discoverable). It
// counts the COLLAPSIBLE dimensions only — the search box (q) sits next to the button and
// is never collapsed, so it is deliberately excluded here.

export function activeFilterCount(f) {
  if (!f) return 0;
  let n = 0;
  if (f.dir && f.dir !== 'all') n++;
  if (f.status && f.status !== 'all') n++;
  if (f.source && f.source !== 'all') n++;
  if (f.bank && f.bank !== 'all') n++;
  if (f.sort && f.sort !== 'date-desc') n++;
  if (f.amountMin !== '' && f.amountMin != null) n++;
  if (f.amountMax !== '' && f.amountMax != null) n++;
  if (f.from) n++;
  if (f.to) n++;
  return n;
}
