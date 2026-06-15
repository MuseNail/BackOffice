// ── changelog — "What's new" notes, shown once per version + on demand ─────────
// Mirrors the Muse app's What's New. The version badge reopens it; the first
// time a device loads a new version it pops automatically.
import { el, modal } from './ui.js';
import { APP_VERSION } from './config.js';

// Newest first. Add an entry each release.
const CHANGELOG = [
  { v: '0.32.0', items: [
    { icon: 'request_quote', t: 'Invoices tab (Invoice2go)', d: 'Import your weekly Invoice2go export, track open balances and A/R aging, and drill into any invoice’s line items and payments.' },
    { icon: 'account_balance', t: 'Payments → ledger → bank', d: 'Post invoice payments to the ledger through a clearing account (fees expensed), then match your bank deposits against it to reconcile.' },
    { icon: 'edit_note', t: 'Manual invoicing', d: 'Create, edit, and take payments on invoices by hand — full QuickBooks-style A/R alongside the import.' },
    { icon: 'account_tree', t: 'QuickBooks accounts import', d: 'Settings → import a client’s chart of accounts from a QuickBooks .IIF export.' },
    { icon: 'menu_book', t: 'In-app guide + hard reset', d: 'Tap your name (top-right) for the App guide and Quick reference (printable to PDF), plus a Hard reset button.' },
  ] },
];

export function showWhatsNew() {
  const m = modal("What’s new");
  for (const rel of CHANGELOG) {
    m.body.append(el('div', { class: 'cardtitle', style: 'margin-top:12px' },
      'v' + rel.v + (rel.v === APP_VERSION ? '  · current' : '')));
    for (const it of rel.items) {
      m.body.append(el('div', { style: 'display:flex;gap:10px;margin:9px 0' },
        el('span', { class: 'ms', style: 'font-size:20px;color:var(--brand)' }, it.icon),
        el('div', {},
          el('div', { style: 'font-weight:700' }, it.t),
          el('div', { class: 'sub', style: 'margin:0' }, it.d))));
    }
  }
  m.body.append(el('div', { style: 'display:flex;justify-content:flex-end;margin-top:14px' },
    el('button', { class: 'btn', onclick: m.close }, 'Got it')));
  try { localStorage.setItem('bo_whatsnew_seen', APP_VERSION); } catch { /* private mode */ }
}

// Auto-show once per version per device.
export function maybeShowWhatsNew() {
  let seen = null;
  try { seen = localStorage.getItem('bo_whatsnew_seen'); } catch { /* private mode */ }
  if (seen === APP_VERSION) return;
  showWhatsNew();
}
