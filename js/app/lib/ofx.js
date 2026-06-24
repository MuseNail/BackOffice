// ── lib: ofx — parse an OFX / QFX / QBO bank statement into normalized rows ──────
// QFX (Quicken) and QBO (QuickBooks Web Connect) are both OFX documents: SGML (OFX
// 1.x, leaf tags often unclosed) or XML (OFX 2.x). Every transaction is a <STMTTRN>
// aggregate carrying a bank-assigned unique id (FITID) — the strongest dedup key
// there is, unlike a CSV row's date+amount+description guess. Pure (no DOM/IO).
import { parseMoney } from './money.js';

// Does this text look like OFX rather than CSV? OFX files open with an "OFXHEADER:"
// block or an <OFX> tag; QBO/QFX both contain <STMTTRN> aggregates.
export function looksLikeOfx(text) {
  const head = String(text).slice(0, 4000).toUpperCase();
  return /<OFX>/.test(head) || /OFXHEADER\s*[:=]/.test(head) || /<STMTTRN>/.test(head);
}

// First value of an SGML/XML tag inside a chunk. Leaf tags in OFX 1.x are usually
// unclosed (<DTPOSTED>20260618...), so read up to the next tag or line break.
function tagVal(chunk, tag) {
  const m = chunk.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? decodeEntities(m[1].trim()) : '';
}

function decodeEntities(s) {
  return s.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
}

// OFX date: YYYYMMDD, optionally followed by HHMMSS[.xxx][TZ]. Return YYYY-MM-DD.
function ofxDate(s) {
  const m = String(s).match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function amountCents(raw) {
  const c = parseMoney(raw);
  if (c != null) return c;
  const f = parseFloat(raw);                       // OFX amounts can carry >2 decimals
  return Number.isFinite(f) ? Math.round(f * 100) : null;
}

// Parse OFX/QFX/QBO text → { rows: [{date, desc, amountCents, fitid}] }.
export function parseOfx(text) {
  const t = String(text);
  let blocks = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = re.exec(t))) blocks.push(m[1]);
  if (!blocks.length) {                             // fallback: leaf-only SGML with no </STMTTRN>
    blocks = t.split(/<STMTTRN>/i).slice(1).map(p => p.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
  }

  const rows = [];
  for (const chunk of blocks) {
    const date = ofxDate(tagVal(chunk, 'DTPOSTED') || tagVal(chunk, 'DTUSER'));
    const cents = amountCents(tagVal(chunk, 'TRNAMT'));
    if (!date || cents == null) continue;
    const name = tagVal(chunk, 'NAME');
    const memo = tagVal(chunk, 'MEMO');
    const desc = [name, memo].filter(Boolean).join(' — ')
      || tagVal(chunk, 'TRNTYPE') || tagVal(chunk, 'CHECKNUM') || 'Transaction';
    rows.push({ date, desc, amountCents: cents, fitid: tagVal(chunk, 'FITID') });
  }
  return { rows };
}
