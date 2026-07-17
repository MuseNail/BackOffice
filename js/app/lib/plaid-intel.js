// ── lib: plaid-intel — per-card bank-feed status from GET /plaid/accounts (pure) ──
// The Banking view enriches each account card with feed intelligence: which offered
// account the bank exposes, whether it's linked, and — for an offered-but-unlinked
// account — a recovery strip. This module decides ONLY which card shows the strip.
//
// The load-bearing safety rule: a card is matched to an offered account by a last-four
// parsed out of the (free-text) account name — a HINT, never a binding key. The actual
// link always goes through a human identity-confirm in plaid-connect.js, mirroring the
// connect flow's pickAccountModal, because "a wrong bind feeds this register from the
// wrong account, and every approval after posts real money to the wrong place." So a
// wrong parse (e.g. "Chase Ink 2019" -> "2019") is caught by a person, not by this code.
//
// No DOM / no IO here so it's unit-tested in tests/plaid-intel.test.mjs.

// The last run of >=3 digits in an account name ("Honey - 8002" -> "8002"). Returns null
// (never '') when there's no such run, so a digit-less name can't false-match.
function maskFromName(name) {
  const runs = String(name == null ? '' : name).match(/\d{3,}/g);
  return runs ? runs[runs.length - 1] : null;
}

// A Plaid mask is usable for matching only if it's a non-empty run of digits — so an
// empty mask can never equal an empty derived mask and false-match.
function digitsMask(mask) {
  const s = String(mask == null ? '' : mask);
  return /^\d+$/.test(s) ? s : null;
}

// plaidIntel(bankaccts, items) -> { [bankacctId]: { status:'linked'|'offered'|'none',
//   candidates:[{itemId, plaidAccountId, name, mask, subtype, institution, itemLastSyncAt}] } }
// `items` are the client-safe publicItem shape from GET /b/:biz/plaid/accounts.
export function plaidIntel(bankaccts, items) {
  bankaccts = Array.isArray(bankaccts) ? bankaccts : [];
  items = Array.isArray(items) ? items : [];

  // Unmapped offered accounts grouped by mask. A mask offered by two Items is ONE logical
  // account with two candidates (re-linking a bank mints a duplicate Item) — never a
  // reason to drop the strip on the very accounts the feature exists to recover. A mapped
  // offered account marks its bankacct linked instead.
  const offeredByMask = new Map();
  const linkedBankacctIds = new Set();
  for (const it of items) {
    for (const a of (it && it.accounts) || []) {
      if (a.mappedTo) { linkedBankacctIds.add(a.mappedTo); continue; }
      const mask = digitsMask(a.mask);
      if (!mask) continue;
      if (!offeredByMask.has(mask)) offeredByMask.set(mask, []);
      offeredByMask.get(mask).push({
        itemId: it.itemId, plaidAccountId: a.plaidAccountId, name: a.name,
        mask, subtype: a.subtype, institution: it.institution || null,
        itemLastSyncAt: it.lastSyncAt || null,
      });
    }
  }

  // How many non-cash book accounts derive each mask. >1 means we can't tell which CARD
  // an offered account belongs to — and the identity-confirm can only catch a wrong
  // ACCOUNT, not a wrong card — so neither gets a strip.
  const cardMaskCount = new Map();
  for (const b of bankaccts) {
    if (b.kind === 'cash') continue;
    const m = maskFromName(b.name);
    if (m) cardMaskCount.set(m, (cardMaskCount.get(m) || 0) + 1);
  }

  const out = {};
  for (const b of bankaccts) {
    // Linked wins on the live bankacct.plaid stamp (rides the snapshot) OR a mapped
    // offered account — so a just-linked account can't keep offering itself when the
    // items cache is stale or a post-link re-fetch failed (which would let a second
    // "Get full history" mint a redundant billable Item).
    if (b.plaid || linkedBankacctIds.has(b.id)) { out[b.id] = { status: 'linked', candidates: [] }; continue; }
    if (b.kind === 'cash') { out[b.id] = { status: 'none', candidates: [] }; continue; }
    const m = maskFromName(b.name);
    if (!m || (cardMaskCount.get(m) || 0) > 1) { out[b.id] = { status: 'none', candidates: [] }; continue; }
    const cands = offeredByMask.get(m);
    if (cands && cands.length) {
      // Prefer a candidate whose Item has actually synced: linking onto it gives the
      // honest "new transactions only" behaviour (a never-synced Item's null cursor
      // backfills instead).
      const sorted = cands.slice().sort((x, y) => (y.itemLastSyncAt ? 1 : 0) - (x.itemLastSyncAt ? 1 : 0));
      out[b.id] = { status: 'offered', candidates: sorted };
    } else {
      out[b.id] = { status: 'none', candidates: [] };
    }
  }
  return out;
}
