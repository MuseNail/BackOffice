// ── changelog — "What's new" notes, shown once per version + on demand ─────────
// Mirrors the Muse app's What's New. The version badge reopens it; the first
// time a device loads a new version it pops automatically.
import { el, modal } from './ui.js';
import { APP_VERSION } from './config.js';

// Newest first. Add an entry each release.
const CHANGELOG = [
  { v: '0.42.0', items: [
    { icon: 'system_update', t: 'Update prompts you won’t miss', d: 'When a new version is published, Back Office now pops up an “Update available” message with an Update button — instead of only a small ↻ on the version number. Tap Update to load the newest version; your data is never affected.' },
  ] },
  { v: '0.41.0', items: [
    { icon: 'account_balance_wallet', t: 'Per-account ledger registers', d: 'Pick a bank or card account at the top of the Ledger to see just that account — a running balance column plus its current balance up top, which should match your bank statement. “All accounts” still shows the whole-business total.' },
    { icon: 'open_in_new', t: 'Tap a balance to open its register', d: 'On Banking, click an account’s balance to jump straight into that account’s register in the Ledger.' },
    { icon: 'add_circle', t: 'Add a category or vendor mid-entry', d: 'When adding or editing a transaction you can now create a new category or vendor inline — it’s selected automatically, just like in Review.' },
    { icon: 'bolt', t: 'Smarter “auto-categorize this vendor”', d: 'The ⚡ rule popup now suggests vendors you already have and adds your new match text to the existing one instead of creating a duplicate.' },
    { icon: 'check_circle', t: 'Pop-ups no longer close mid-drag', d: 'Selecting text by dragging inside a dialog no longer accidentally dismisses it.' },
  ] },
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
