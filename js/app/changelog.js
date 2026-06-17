// ── changelog — "What's new" notes, shown once per version + on demand ─────────
// Mirrors the Muse app's What's New. The version badge reopens it; the first
// time a device loads a new version it pops automatically.
import { el, modal } from './ui.js';
import { APP_VERSION } from './config.js';

// Newest first. Add an entry each release.
const CHANGELOG = [
  { v: '0.60.0', items: [
    { icon: 'view_agenda', t: 'Review redesigned — everything in view', d: 'Each transaction in Review is now its own card with all fields always visible (category, vendor, invoice, note, actions) — no more clicking to expand. Long bank descriptions wrap onto two lines, columns are separated by dashed dividers, and each row has a clear outline so they’re easy to tell apart.' },
    { icon: 'unfold_more', t: 'Collapse accounts + page through them', d: 'Click an account’s name to collapse/expand its transactions, and page through them 50 at a time instead of only seeing the first 100 — so you can work through all of them.' },
  ] },
    { icon: 'close', t: 'Esc closes pop-ups', d: 'Press Escape to close any open dialog (the top-most one first).' },
    { icon: 'gradient', t: 'Clearer cards', d: 'Cards/panels now have a softer drop shadow so each one reads as a distinct tile.' },
    { icon: 'dashboard_customize', t: 'Tidier Banking screen', d: 'Account tiles are now a uniform grid — same size and layout, with buttons aligned at the bottom — and the import list has an “Import history” heading.' },
  ] },
  { v: '0.58.0', items: [
    { icon: 'view_sidebar', t: 'Sidebar + top bar stay put', d: 'The left menu and the top bar are now fixed — they no longer scroll away when you page through long lists, so navigation is always one click away.' },
    { icon: 'unfold_less', t: 'Tighter layout + collapsible lists', d: 'Trimmed extra whitespace so more fits on screen, and long lists (like “other income” on the reconcile screen) now collapse — click to expand only what you need.' },
  ] },
  { v: '0.57.0', items: [
    { icon: 'filter_alt', t: 'Reconcile screen focuses on the app-owned period', d: 'The “Reconcile to bank” screen now only shows deposits from your import start date onward — your QuickBooks historical deposits (already reconciled there) no longer clutter the “other income” list.' },
  ] },
  { v: '0.56.0', items: [
    { icon: 'task_alt', t: 'One-click deposit matching', d: 'On the “Reconcile to bank” screen, a button now posts all matched Invoice2go deposits at once — each is recorded in your bank and relieves the Invoice2go Clearing account, which drains toward $0 (the proof every Invoice2go dollar landed as a real deposit). The clearing balance shows live as you go. Also relabeled payout methods to plain English (“instant payout”, “same-day ACH”).' },
  ] },
  { v: '0.55.0', items: [
    { icon: 'compare_arrows', t: 'Reconcile Invoice2go to your bank', d: 'A new “Reconcile to bank” screen (Invoices tab) automatically matches each Invoice2go payout to the bank deposit it produced — same amount, right timeframe — and shows you the two things that need attention: Invoice2go payouts with no matching deposit, and bank deposits that aren’t Invoice2go (your other income). Read-only for now; one-click matching is next.' },
  ] },
  { v: '0.54.0', items: [
    { icon: 'account_balance', t: 'Groundwork for bank-deposit reconciliation', d: 'Invoice2go now posts to its own dedicated “Invoice2go Clearing” account (instead of sharing QuickBooks’ Undeposited Funds), so its balance is purely Invoice2go money awaiting a deposit — clean to reconcile. The import also records every payout (including fee-free ones) with the exact amount that hits your bank, ready to be matched against your bank deposits. The matching screen comes next.' },
  ] },
  { v: '0.53.0', items: [
    { icon: 'event_busy', t: 'Start date on the Invoice2go import', d: 'The one-file import now has a “Start date” (defaults to Oct 1, 2025): invoices and cashflow dated before it are skipped, so periods already covered by your QuickBooks import aren’t double-counted. The date is remembered for next time.' },
  ] },
  { v: '0.52.0', items: [
    { icon: 'event', t: 'Clearer invoice dates', d: 'An invoice now shows its dates in a clean, labeled row — Invoice date, Created, Due, and Paid — so there’s no guessing which date is which. The invoice list column is labeled “Invoice date.” (Invoice2go doesn’t export a separate event date — that lives in the line-item text.)' },
  ] },
  { v: '0.51.0', items: [
    { icon: 'search', t: 'Drill into an invoice’s costs and fees', d: 'On an invoice, the profit lines — Job expenses, Card fee absorbed, Payout fee, Fee passed to customer — are now clickable: each opens the exact transactions behind it, and you can open any one to see its full debit/credit detail. The “Linked expenses” list is clickable too.' },
    { icon: 'cleaning_services', t: 'Cleaner “Linked expenses”', d: 'The Linked expenses card now shows only real job costs. The Invoice2go fee bookings (which already appear in the profit breakdown) and empty $0.00 entries no longer clutter the list.' },
  ] },
  { v: '0.50.0', items: [
    { icon: 'bolt', t: 'One-file Invoice2go import — invoices + cashflow together', d: 'The Invoices tab now imports a single file: the one-click Invoice2go export brings in every invoice (client, total, balance, status) AND the real cashflow in one step — each payment posted with its actual fees (absorbed → cost of goods, passed-to-customer → contra-income, plus the 1% instant-payout fees), all tagged to their invoice. Each invoice shows an honest profit breakdown, and the fee the customer covered is read straight from the real data. Safe to re-run weekly; nothing duplicates.' },
    { icon: 'list_alt', t: 'Add line-item detail whenever you like', d: 'The one-click import doesn’t include itemized lines. A separate “Add line-item detail” tool lets you upload the Invoice2go invoice CSV monthly or quarterly to fill in line items on the invoices you already have — matched by number. It only adds line items; it never changes the totals or payments the weekly import owns.' },
  ] },
  { v: '0.49.0', items: [
    { icon: 'paid', t: 'Invoice2go cashflow import + honest per-invoice profit', d: 'A new “Post Invoice2go cashflow” tool (Invoices tab) imports your Invoice2go transactions export and books payments with their REAL fees — no estimates: the part a customer covered (a surcharge) is recorded as contra-income (nets out, no profit hit), the part you absorbed goes to cost of goods, and the 1% instant-payout fees are booked too, each tagged to its invoice. Every invoice then shows a clean profit breakdown — revenue, job expenses, card fee absorbed, payout fee, profit and profit %, plus what you passed to the customer. Each payment’s net lands in a clearing account; when your bank deposits relieve it to $0, your invoices are matched to your deposits to the penny.' },
  ] },
  { v: '0.47.0', items: [
    { icon: 'percent', t: 'Invoice2go fees now count toward each job’s profit', d: 'When you post Invoice2go payments, the card processing fee is tagged to that invoice, so it shows in the job’s profit margin. And every invoice now has a “＋ Payout fee” button to record Invoice2go’s 1% instant-payout fee — it pre-fills 1% of the payment, books it to your Payout Fee account against that invoice, and leaves your bank balance untouched.' },
  ] },
  { v: '0.46.0', items: [
    { icon: 'edit_note', t: 'Edit transactions right in the list', d: 'In the Ledger and in any account or vendor register, you can now change a transaction’s category, vendor, note, and linked invoice without opening a popup — the fields sit right in the row on a computer, and tuck behind a tap on a phone. Less clicking to fix or tag things.' },
    { icon: 'account_balance', t: 'Import your QuickBooks history', d: 'A new tool in Settings imports a full QuickBooks “Transaction Detail by Account” export: it brings in your chart of accounts and every bank and credit-card transaction, marks the ones already cleared in QuickBooks as reconciled, and tags expenses to the job invoice written in their memo (“Inv. ####”). Your bank balances come in matching QuickBooks to the penny, so you can reconcile the open periods against your statements.' },
  ] },
  { v: '0.45.0', items: [
    { icon: 'space_dashboard', t: 'A Dashboard you can click into', d: 'Each number on the Dashboard now opens a breakdown when you click it: Cash position lists every bank account, Income and Expenses break down by category, and Net shows a mini profit-and-loss. Each card also compares this month to last. A new “Bank accounts” panel lists your accounts — click one to jump straight into its register.' },
    { icon: 'request_quote', t: 'A clearer Invoices list', d: 'Click anywhere on an invoice row to open it. The list now has a “Source” column showing whether an invoice was entered by hand (Manual) or imported from Invoice2go, an “Overdue” status for past-due open balances, and A/R aging buttons you can tap to filter the list to just that age range.' },
  ] },
  { v: '0.44.0', items: [
    { icon: 'table_rows', t: 'Click a transaction to edit it', d: 'In the Ledger, click anywhere on a transaction row to open its editor (you no longer have to aim for the small “Edit” link). The Save button is green to match Add.' },
    { icon: 'checklist', t: 'Faster Review', d: 'The Review screen now works like QuickBooks: each bank transaction shows as a tidy one-line row — click it to open the category, note, vendor and the rule/fee/match actions. After you Approve a row, the next one opens automatically so you can fly down the list.' },
  ] },
  { v: '0.43.0', items: [
    { icon: 'update', t: 'Self-updating', d: 'Back Office now checks for a new version on its own periodically, so the “Update available” prompt appears even on a device left open all day — no need to close and reopen first.' },
  ] },
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
