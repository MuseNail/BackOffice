// ── lib: money — integer cents at every boundary ────────────────

// "1,234.56" / "$12" / "12.5" / "-3" → integer cents, or null if unparseable.
export function parseMoney(input) {
  const s = String(input ?? '').replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '-' || s === '.') return null;
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return neg ? -cents : cents;
}

export function fmtCents(cents, { sign = false } = {}) {
  const n = Math.abs(cents) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cents < 0 ? '−$' : (sign ? '+$' : '$')) + s;
}
