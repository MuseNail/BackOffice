// ── changelog — "What's new" notes, shown once per version + on demand ─────────
// Mirrors the Muse app's What's New. The version badge reopens it; the first
// time a device loads a new version it pops automatically.
import { el, modal } from './ui.js';
import { APP_VERSION } from './config.js';

// Newest first. Add an entry each release.
const CHANGELOG = [
  { v: '0.68.17', items: [
    { icon: 'account_tree', t: 'See full account names + quick-add accounts', d: 'The account picker dropdown is now wider and wraps long names, so you can read full parent › child account paths instead of them getting cut off. Typing an account that doesn’t exist yet pops up a quick “add it?” setup (prefilled with what you typed) — just like vendors. And approving a batch of transactions now shows a “⏳ Approving…” indicator so you know it’s working.' },
  ] },
  { v: '0.68.16', items: [
    { icon: 'edit_note', t: 'Vendor-picker & Review polish', d: 'In a vendor box, pressing Tab on a highlighted vendor now selects it and jumps to the next field. Typing a vendor that doesn’t exist pops up a quick “add it?” confirm (prefilled) instead of dropping it. The ⚡ Rule button carries over the account and vendor you already picked on the row. And on the Review tab, the title, search box, filters, and action buttons now stay pinned at the top as you scroll through a long list.' },
  ] },
  { v: '0.68.15', items: [
    { icon: 'search', t: 'Search bars on Review, Vendors & Customers', d: 'Review now has a search box that finds transactions by description, amount, or matched vendor. The Vendors tab searches by name or rule text, and the Customers tab by name. (Reminder: your auto-categorize rules live on the Vendors tab — see the “Rule” column next to each vendor.)' },
  ] },
  { v: '0.68.14', items: [
    { icon: 'smart_toy', t: 'AI suggestions that learn from you', d: 'When you tap “✨ Get AI suggestions”, the AI now also sees how you’ve categorized past transactions and follows your own patterns, so new rows get the account you’d pick. It runs on the cheaper Haiku model, and if it ever can’t run it now tells you exactly why (for example, the Anthropic account is out of credits).' },
  ] },
  { v: '0.68.13', items: [
    { icon: 'calculate', t: 'A calculator in every dollar field', d: 'Every amount field now works like a calculator: type an expression such as 40+5*2 and it adds it up left-to-right (like a cash register), showing a little running tape as you go and filling in the answer when you press Enter or click away. Plain amounts also fill in cents automatically — “5014” becomes “5014.00” — so dollar fields are always consistent. Percent and quantity fields keep the calculator but skip the cents.' },
  ] },
  { v: '0.68.12', items: [
    { icon: 'call_split', t: 'Split one payment across accounts', d: 'When adding a transaction, “＋ Add split” now lets you divide one payment across several accounts — e.g. part Supplies, part Retail. The leftover auto-fills the next line so it always balances to the amount, with no need for the Journal tool. (Editing an existing split comes next.) The Journal-entry tool also gained a × to remove a line and an “Auto-balance” button that fills the last line to make debits equal credits.' },
  ] },
  { v: '0.68.11', items: [
    { icon: 'chevron_right', t: 'Breadcrumb trail on drill-down screens', d: 'When you open a vendor, account, customer, or invoice, a trail now shows at the top — e.g. “Vendors › Sally Beauty”. Click the parent to step back. The ← Back button is still there too.' },
    { icon: 'manage_search', t: 'Payee & Memo now autocomplete', d: 'Start typing a payee or a note and the app suggests names and notes you’ve used before — in the Add/Edit transaction forms, the Review notes, and the inline edits in the Ledger and registers. Less typing, consistent spelling.' },
    { icon: 'bolt', t: 'Icons load instantly, even offline', d: 'The app’s icons are now bundled with it instead of fetched from Google on every load, so they always appear right away and work with no internet.' },
  ] },
  { v: '0.68.10', items: [
    { icon: 'vertical_align_top', t: 'Reports header stays put', d: 'On Reports, the “Profit & Loss” title, the period/compare controls, and the Print/PDF + Export buttons now stay pinned at the top while you scroll a long report. The Balance Sheet and Tax estimate boxes no longer stretch to match the P&L’s height — each box is now sized to its own content.' },
  ] },
  { v: '0.68.9', items: [
    { icon: 'build', t: 'Reports column styling — now applied', d: 'The Profit & Loss comparison column alignment and dividers from the last update are now actually in effect (the styling had been left out by mistake).' },
  ] },
  { v: '0.68.8', items: [
    { icon: 'view_column', t: 'Clearer Reports columns', d: 'On the Profit & Loss comparison, the column headings now line up right above their numbers, and light vertical dividers separate the columns so it’s easier to read across a row.' },
  ] },
  { v: '0.68.7', items: [
    { icon: 'rule', t: 'Smarter auto-categorize rules', d: 'When you build a ⚡ rule (in Review or on the Vendors tab) you can now match the bank description by “contains”, “starts with”, “is exactly”, or a pattern — and add more than one condition. You can also limit a rule to deposits only, withdrawals only, or an amount range, so the same name (like Venmo) can go to different accounts depending on the amount. A live preview shows how many of your transactions the rule would catch before you save. The Vendors tab now lists each vendor’s rule at a glance.' },
  ] },
  { v: '0.68.6', items: [
    { icon: 'tune', t: 'Reports controls fixed', d: 'On Reports, the Profit & Loss header no longer shows scrollbars — the period and comparison controls now wrap onto a second line when there isn’t room, and the date calendar opens above everything else instead of being cut off.' },
  ] },
  { v: '0.68.5', items: [
    { icon: 'checklist', t: 'Approve or skip many transactions at once', d: 'On Review, each waiting transaction now has a checkbox, plus a “Select all” on each account. Tick the ones you want and a bar appears at the top to approve them, skip them, or set one account or vendor across the whole batch in a single step. Selection stays within one account at a time. Approving leaves anything still missing an account selected, so nothing posts by accident.' },
  ] },
  { v: '0.68.4', items: [
    { icon: 'add_circle', t: 'One “+ New” button to create anything', d: 'A new “+ New” button sits in the top bar on every screen. Click it to create a transaction, invoice, customer, vendor, account, or bank/card account, or to import a bank file — each opens the same form you use today, no need to hunt for the right screen first. Keyboard shortcut: press N, then T (transaction), I (invoice), C (customer), or V (vendor). It won’t trigger while you’re typing in a box or have a window open.' },
  ] },
  { v: '0.68.3', items: [
    { icon: 'compare_arrows', t: 'Compare Profit & Loss against another period', d: 'On Reports, a new “Compare to” menu lets you put this period next to the previous period or the same period last year — with a Change column that’s green when it helps your profit and red when it hurts (so rising expenses show red, falling ones green). Or pick Monthly trend to see each month side by side. There’s also a “% of income” toggle to show every line as a share of total income. The comparison carries through to the CSV export and the printout.' },
  ] },
  { v: '0.68.2', items: [
    { icon: 'splitscreen', t: 'Review filters in two rows', d: 'The Review filter bar is now a tidy two-row layout — show/order filters on top, amount + date + clear on the bottom — so it no longer overflows.' },
  ] },
  { v: '0.68.1', items: [
    { icon: 'tune', t: 'Date picker + layout tweaks', d: 'Fixed the calendar closing when you tapped the previous/next-month arrows. Every date picker is now a consistent fixed width so changing the range no longer shifts the layout. The top search box is wider, and switching businesses moved from the sidebar into your account menu (top-right).' },
  ] },
  { v: '0.68.0', items: [
    { icon: 'account_tree', t: 'Profit & Loss you can expand and drill into', d: 'The P&L now shows each parent account as one line with its rolled-up total; click it to expand the sub-accounts (indented, with their own subtotals). Any account with no sub-accounts — and each sub-account — is clickable to open the exact transactions that make up its total, and from there you can click any transaction to edit it.' },
  ] },
  { v: '0.67.5', items: [
    { icon: 'view_column', t: 'Reports header tidy-up', d: 'The Profit & Loss period picker and the Balance Sheet “As of” picker now each sit on their own line under the panel title, and both panels’ first lines — Income and Assets — line up.' },
  ] },
  { v: '0.67.3', items: [
    { icon: 'tune', t: 'Calendar alignment + drilldown dates', d: 'The date calendar now opens lined up under its button (no more sideways offset by the ‹ › arrows) and flips to stay on-screen near the right edge. In a Vendor or Customer pop-up you can now change the date range right there — the totals update without closing the pop-up. On Reports, the “As of” picker sits on the Balance Sheet title line.' },
  ] },
  { v: '0.67.2', items: [
    { icon: 'bug_report', t: 'Date picker fixes', d: 'Fixed the calendar leaving an empty box under the button and not closing — it now opens and closes when you click the button again or click away.' },
    { icon: 'event_available', t: 'Quick “as of” dates on the Dashboard', d: 'The Dashboard cash-position date now offers End of last week / last month / last quarter (each lands on the last day of that period). The Ledger’s date filter now defaults to This year.' },
  ] },
  { v: '0.67.0', items: [
    { icon: 'calendar_month', t: 'A real calendar date picker — everywhere', d: 'Every date control is now one button that opens a calendar with smart ranges down the side: Today, This/Last week, This/Last month, This/Last quarter, Year to date, This/Last year, or All time — plus ‹ › arrows to step a period at a time. Click a day for that day, or a start then an end for a custom range. It’s the same picker on Reports, the Ledger, Review, account/vendor registers, Reconcile, and the Dashboard.' },
    { icon: 'filter_alt', t: 'Filter Review by amount and date', d: 'The Review screen gained a min/max amount filter and the same calendar date filter as the rest of the app, so you can zero in on exactly the transactions you want to work through.' },
    { icon: 'table_rows', t: 'Tidier Ledger rows', d: 'The Ledger no longer scrolls sideways: Vendor, Account, Invoice, and Memo are packed into a compact 2×2 block on each row. Click anywhere on a row (except the dropdowns) to open it for editing, and Delete / Void now live inside that edit window instead of crowding every row.' },
    { icon: 'account_tree', t: '“Category” is now “Account”', d: 'To match your chart of accounts, the pickers and labels that used to say “Category” now say “Account” throughout the app.' },
    { icon: 'unfold_more', t: 'Dropdown arrows always visible', d: 'Long names in a dropdown no longer overlap the little arrow — every dropdown keeps its arrow clear.' },
  ] },
  { v: '0.66.0', items: [
    { icon: 'search', t: 'Type-to-search category & vendor pickers', d: 'On the Review screen, the Category and Vendor pickers are now search boxes — start typing to filter the list instead of scrolling a long dropdown. “＋ Add category / vendor” is still pinned at the bottom.' },
    { icon: 'bolt', t: 'Rules and transactions stay in sync', d: 'When you make a ⚡ Rule from a transaction in Review, the category (and vendor) you choose now carries straight back onto that transaction, ready to approve — and if the row already had a category, the Rule pop-up starts pre-filled with it.' },
    { icon: 'lock_clock', t: 'No accidental edits in the Ledger', d: 'Editing a category or vendor right in the Ledger now only saves when you press Tab/Enter or click away — and scrolling the mouse wheel over a field can no longer change it by accident. Press Esc to cancel an edit.' },
    { icon: 'history', t: 'Activity log', d: 'A new “Activity” screen (in the sidebar) keeps a running, read-only record of changes — posts, edits, voids, deletes, reconciliations, rules, and account changes — with who did it and when. Filter by date, action, or text.' },
    { icon: 'date_range', t: 'Smart dates everywhere', d: 'The smart date picker — Today, This/Last week, This/Last month, This/Last quarter, Year to date, This/Last year, or a custom range — is now on Reports too. Reconcile gained quick “end of this/last month” buttons for the statement date.' },
    { icon: 'open_in_new', t: 'Account registers open as a pop-up', d: 'Clicking an account in the Chart of Accounts now opens its register in a pop-up window — no more navigating away and clicking Back.' },
    { icon: 'payments', t: 'Set the payment method (Zelle, etc.)', d: 'On an invoice, each payment’s method is now editable — so a payment Invoice2go labeled “manual payment” can be set to Zelle, cash, check, and so on. The label sticks through weekly re-imports.' },
    { icon: 'sell', t: 'Search tells you the transaction type', d: 'Global search results now tag each transaction with its type — Deposit, Transfer, Zelle, ACH, Card, ATM, Check, or Expense — at a glance.' },
    { icon: 'gradient', t: 'Easier on the eyes', d: 'The left menu items are now tiles, and cards/panels have a slightly stronger shadow so each reads as its own surface.' },
  ] },
  { v: '0.65.0', items: [
    { icon: 'bookmark_add', t: 'Memorized category per vendor', d: 'Open a vendor and pick a “Memorized category” — future imports from that vendor will auto-suggest it (it also seeds a name match so it catches the bank description).' },
    { icon: 'menu_open', t: 'Collapsible side menu', d: 'The ▤ button (top-left) collapses the left menu to a slim icon rail to free up space. Hover it to peek the full menu; it tucks away again when you move off. Click the button to pin it open. Your choice is remembered.' },
    { icon: 'filter_alt_off', t: 'Clear filters on Review', d: 'Review now has an always-visible “Clear filters” button.' },
  ] },
  { v: '0.64.0', items: [
    { icon: 'event_available', t: 'Dashboard: cash position as of any date', d: 'A date picker on the Dashboard lets you see your cash position — and each bank balance — as of a chosen date, not just today.' },
    { icon: 'filter_list', t: 'Ledger filters upgraded', d: 'The Ledger now uses the smart date picker (quick ranges + custom), a new “type” filter (deposits, money out, Zelle, ACH, card, ATM, check, transfer), and a single account selector (the tab bar) instead of the duplicate dropdown.' },
  ] },
  { v: '0.63.0', items: [
    { icon: 'date_range', t: 'Date range on Vendors & Customers totals', d: 'A smart date picker at the top of Vendors and Customers (quick ranges like This year / This quarter / This month, or a custom from–to) — it defaults to this year and controls the “Total paid / received” and transaction counts. Same picker is coming to the Ledger, Dashboard and Reports.' },
  ] },
  { v: '0.62.0', items: [
    { icon: 'table_view', t: 'Vendors & Customers now match', d: 'Both screens show the same clean list — name, number of transactions, and total (paid for vendors, received for customers). Click any row to open a pop-up with that vendor/customer’s transactions and an Edit/Delete button (Esc closes it). The “New” button stays pinned at the top while you scroll.' },
    { icon: 'cleaning_services', t: 'Cleaner vendor list', d: 'Removed the amber “category archived” highlight, and the transaction count is now real (it was always showing 0).' },
  ] },
  { v: '0.61.1', items: [
    { icon: 'bug_report', t: 'Fix: Deposits screen crash', d: 'The salon Deposits screen could fail to render due to an internal naming bug. Fixed.' },
  ] },
  { v: '0.61.0', items: [
    { icon: 'groups', t: 'Customer directory', d: 'A new Customers screen (in the sidebar) lists your clients — click one to see all their transactions and total received, just like Vendors. Income can be tagged to a customer the way expenses are tagged to a vendor.' },
  ] },
  { v: '0.60.0', items: [
    { icon: 'view_agenda', t: 'Review redesigned — everything in view', d: 'Each transaction in Review is now its own card with all fields always visible (category, vendor, invoice, note, actions) — no more clicking to expand. Long bank descriptions wrap onto two lines, columns are separated by dashed dividers, and each row has a clear outline so they’re easy to tell apart.' },
    { icon: 'unfold_more', t: 'Collapse accounts + page through them', d: 'Click an account’s name to collapse/expand its transactions, and page through them 50 at a time instead of only seeing the first 100 — so you can work through all of them.' },
  ] },
  { v: '0.59.0', items: [
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
