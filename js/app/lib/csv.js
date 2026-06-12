// ── lib: csv — parse, column auto-detection, normalization (pure) ────────────────
import { parseMoney } from './money.js';

// RFC-ish CSV: quoted fields, "" escapes, commas/newlines inside quotes, CRLF.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };
  return { headers: rows[0].map(h => h.trim()), rows: rows.slice(1) };
}

// '06/08/2026', '6/8/26', '2026-06-08', '06-08-2026' → '2026-06-08' (US order).
export function parseDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return iso(year, m[1], m[2]);
  }
  return null;
}

function iso(y, mo, d) {
  const m = parseInt(mo, 10), day = parseInt(d, 10);
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Guess which columns are which. Returns indexes (or null):
// { date, desc, amount, debit, credit } — amount OR debit+credit pair.
export function detectColumns(headers, rows) {
  const H = headers.map(h => h.toLowerCase());
  // first column matching the EARLIEST regex wins — specific names beat vague
  // ones (Chase has both "Details" [a type marker] and "Description")
  const find = (...res) => {
    for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i !== -1) return i; }
    return null;
  };
  const out = {
    date: find(/post.*date/, /trans.*date/, /^date/, /date/),
    desc: find(/^desc/, /payee/, /memo/, /narrative/, /^name/, /detail/),
    amount: find(/^amount$/, /amount/),
    debit: find(/debit/, /withdraw/),
    credit: find(/credit/, /deposit/),
  };
  if (out.debit != null && out.credit != null) out.amount = null;
  else { out.debit = null; out.credit = null; }

  const sample = rows.slice(0, 25);
  const frac = (idx, pred) => {
    if (idx == null || !sample.length) return 0;
    return sample.filter(r => pred(r[idx])).length / sample.length;
  };
  // fall back to content sniffing when headers were unhelpful
  if (out.date == null || frac(out.date, v => parseDate(v)) < 0.6) {
    for (let i = 0; i < headers.length; i++) if (frac(i, v => parseDate(v)) >= 0.8) { out.date = i; break; }
  }
  if (out.amount == null && out.debit == null) {
    for (let i = 0; i < headers.length; i++) {
      if (i === out.date) continue;
      if (frac(i, v => parseMoney(v) != null && /\d/.test(String(v))) >= 0.8) { out.amount = i; break; }
    }
  }
  if (out.desc == null) {
    let best = null, bestLen = 0;
    for (let i = 0; i < headers.length; i++) {
      if (i === out.date || i === out.amount || i === out.debit || i === out.credit) continue;
      const len = sample.reduce((s, r) => s + String(r[i] || '').length, 0);
      if (len > bestLen) { bestLen = len; best = i; }
    }
    out.desc = best;
  }
  return out;
}

// Apply a mapping to raw rows → normalized {date, desc, amountCents, raw} (+ rejects).
export function normalizeRows(rows, map, { invert = false } = {}) {
  const good = [], bad = [];
  for (const r of rows) {
    const date = parseDate(r[map.date]);
    const desc = String(r[map.desc] ?? '').replace(/\s+/g, ' ').trim();
    let cents = null;
    if (map.amount != null) cents = parseMoney(r[map.amount]);
    else {
      const d = parseMoney(r[map.debit]), c = parseMoney(r[map.credit]);
      if (d != null && d !== 0) cents = -Math.abs(d);
      else if (c != null && c !== 0) cents = Math.abs(c);
    }
    if (cents != null && invert) cents = -cents;
    if (!date || !desc || cents == null || cents === 0) { bad.push(r); continue; }
    good.push({ date, desc, amountCents: cents, raw: r });
  }
  return { good, bad };
}

// Stable identity of a bank row — what "already imported" means.
export function dedupHash(row) {
  return `${row.date}|${row.amountCents}|${row.desc.toLowerCase()}`;
}
