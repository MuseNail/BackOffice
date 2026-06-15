// ── lib: qb-iif-import — QuickBooks Desktop IIF chart-of-accounts reader ────────
// Pure parser (no DOM/IO). Reads ONLY the !ACCNT section of an IIF export and
// maps each QuickBooks account to our shape. Transactions are intentionally out
// of scope here — this is the chart-of-accounts import only.
//
// IIF is tab-delimited, section-based: a header row starts with `!ACCNT` and
// names the columns; data rows start with `ACCNT`. Other sections (!CUST, !VEND,
// !TRNS, …) are ignored. QB writes subaccounts as `Parent:Child` in NAME.

// QuickBooks ACCNTTYPE → our {type, qbType}. qbType keeps QB's own vocabulary so
// a later IIF EXPORT round-trips 1:1 (see qb-iif.js). CCARD lands as qbType
// 'CCARD' so the account is offered as a transfer target in pickers.
const QB_ACCNT_MAP = {
  BANK: { type: 'asset', qbType: 'BANK' },
  CCARD: { type: 'liability', qbType: 'CCARD' },
  AR: { type: 'asset', qbType: 'OCASSET' },
  OCASSET: { type: 'asset', qbType: 'OCASSET' },
  OASSET: { type: 'asset', qbType: 'OCASSET' },
  FIXASSET: { type: 'asset', qbType: 'FIXASSET' },
  AP: { type: 'liability', qbType: 'OCLIAB' },
  OCLIAB: { type: 'liability', qbType: 'OCLIAB' },
  LTLIAB: { type: 'liability', qbType: 'LTLIAB' },
  EQUITY: { type: 'equity', qbType: 'EQUITY' },
  INC: { type: 'income', qbType: 'INC' },
  EXINC: { type: 'income', qbType: 'INC' },
  EXP: { type: 'expense', qbType: 'EXP' },
  EXEXP: { type: 'other-expense', qbType: 'EXP' },
  COGS: { type: 'cogs', qbType: 'COGS' },
};

const unquote = (s) => {
  const t = String(s == null ? '' : s).trim();
  return t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"' ? t.slice(1, -1).replace(/""/g, '"') : t;
};

// `Parent:Sub:Leaf` → { name: 'Leaf', parentName: 'Parent:Sub' }. We keep the
// full path as the parent key (resolved at import time) and the last segment as
// the display name — matching our one-level model's "leaf + parentId" shape.
function splitName(qbName) {
  const parts = qbName.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return { name: qbName.trim(), parentName: null };
  return { name: parts[parts.length - 1], parentName: parts.slice(0, -1).join(':') };
}

// Parse an IIF file's !ACCNT section. Returns:
//   accounts: [{ qbName, name, parentName, type, qbType, accntType }]
//   skipped:  [{ qbName, accntType, reason }]   (non-posting or unknown types)
// Order is preserved so parents (which QB lists before children) resolve cleanly.
export function parseIifAccounts(text) {
  const accounts = [];
  const skipped = [];
  const seen = new Set();
  let cols = null; // current !ACCNT header column order

  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw) continue;
    const cells = raw.split('\t');
    const tag = (cells[0] || '').trim().toUpperCase();

    if (tag === '!ACCNT') {
      cols = cells.map(c => c.trim().toUpperCase());
      continue;
    }
    if (tag !== 'ACCNT') continue; // a different section's data row
    if (!cols) continue; // ACCNT data before its header — malformed, skip

    const nameIdx = cols.indexOf('NAME');
    const typeIdx = cols.indexOf('ACCNTTYPE');
    if (nameIdx === -1 || typeIdx === -1) continue;

    const qbName = unquote(cells[nameIdx]);
    const accntType = unquote(cells[typeIdx]).toUpperCase();
    if (!qbName) continue;

    const dedup = qbName.toLowerCase();
    if (seen.has(dedup)) continue; // QB can repeat a row; first wins
    seen.add(dedup);

    if (accntType === 'NONPOSTING') { skipped.push({ qbName, accntType, reason: 'non-posting' }); continue; }
    const map = QB_ACCNT_MAP[accntType];
    if (!map) { skipped.push({ qbName, accntType, reason: 'unrecognized type' }); continue; }

    const { name, parentName } = splitName(qbName);
    accounts.push({ qbName, name, parentName, type: map.type, qbType: map.qbType, accntType });
  }
  return { accounts, skipped };
}

export { QB_ACCNT_MAP };
