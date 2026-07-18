// ── changelog — "What's new" notes, shown once per version + on demand ─────────
// Mirrors the Muse app's What's New. The version badge reopens it; the first
// time a device loads a new version it pops automatically.
import { el, modal } from './ui.js';
import { APP_VERSION } from './config.js';

// Newest first. Add an entry each release.
const CHANGELOG = [
  { v: '0.71.11', items: [
    { icon: 'schedule', t: 'Dates now follow your own time zone', d: 'You’re in Pacific time, but a few places worked out “today” in a way that flipped to tomorrow’s date in the evening — so a transaction you added after about 4–5pm could default to the next day, and on the last evening of a month the dashboard could show the wrong month. Everywhere you enter or see “today” or “this month” now uses your local day. Nothing you’d already saved changes; imported and synced transactions were never affected.' },
    { icon: 'filter_alt', t: 'Review: see and filter where each suggestion came from', d: 'Each row in Review already showed a small tag for where its suggested account came from — 💬 from your client, ⚡ from a rule, ✨ from AI, or 🕘 because you approved the same thing before. Those tags are now clearer and consistent, and there’s a new “source” filter in the toolbar so you can show just client-suggested, AI-suggested, rule-matched, seen-before, or not-yet-suggested rows.' },
    { icon: 'inventory_2', t: 'Review: “Save for later” and a real “Delete”', d: 'The old “Skip” is now “Save for later” — it parks a row in a list you can reopen and restore anytime, and you can now select several (or all) saved rows to restore or delete at once. New alongside it is “Delete”, which removes a row for good — and, unlike before, a deleted transaction stays gone even if your bank re-sends or re-links it. Neither ever touches your ledger; these are transactions you haven’t posted yet.' },
    { icon: 'call_split', t: 'Split a transaction across several vendors, with a note each', d: 'When you split a transaction across accounts in the transaction editor, each split line can now carry its own vendor and its own note (tap “＋ detail” on a line to add them) — and you can reopen an already-split transaction to change them. Your Vendors report and totals now credit each split to the right vendor instead of lumping the whole transaction under one, and the QuickBooks export carries each split’s vendor and note through. A line you don’t tag still falls back to the transaction’s vendor, so nothing you already have changes.' },
  ] },
  { v: '0.71.10', items: [
    { icon: 'verified_user', t: 'The server itself now refuses a change headed into the wrong company’s books', d: 'Every change made while a company’s books are open is now sealed with that company’s name. Before saving anything, the server compares the seal to the books the change actually arrived at — and if they don’t match, it refuses to save it. A refused change isn’t lost: it’s held under Settings → Data & maintenance with an alert to you, already pointing at the company it was made in, one tap to file. Until now this protection lived only in the app; with the server checking too, a future app bug that mis-addresses a sealed change can’t quietly put it in another company’s ledger. Day to day nothing looks different — this only acts if something is genuinely wrong.' },
    { icon: 'lock_reset', t: 'Fixed: signing back in after the 30-minute auto sign-out left the tab half-connected', d: 'After the idle auto sign-out, signing back into the same company left the tab in a subtle bad state: your changes were routed by leftover “which company was I on” markers instead of the company on screen, and live updates from other devices quietly stopped arriving until you switched companies. Re-entering a company now always re-opens it properly. Also fixed: a user with a single business could get stuck on the sign-in screen after the auto sign-out — signing in didn’t navigate anywhere because the app thought it was already there.' },
    { icon: 'inventory', t: 'The held-writes safety net got stronger', d: 'The “Held & rejected writes” log now keeps up to 200 un-filed held writes separately from the 100 most recent server-rejected diagnostics, so a pile of one can never push out the other. If a held write ever would be pushed out, or can’t be stored at all, you’re alerted by name instead of it disappearing silently. And with two tabs open, a rare timing overlap could previously drop a queued change without sending it — that’s closed.' },
  ] },
  { v: '0.71.9', items: [
    { icon: 'account_balance', t: 'Each open tab stays pinned to its own company', d: 'When you have more than one business open in separate tabs, each tab now routes its changes by the company it’s actually showing — its own — instead of a single shared “which company is active” marker that the last-focused tab could change. So a change made in one tab can’t land in another company’s books, even during the moment a company is still loading. This also covers connecting or syncing a bank feed (it goes to the company you’re viewing, not whichever tab was focused last) and the AI matching tools (one company’s data is never sent under another’s).' },
  ] },
  { v: '0.71.8', items: [
    { icon: 'shield', t: 'The app no longer guesses which company a write belongs to', d: 'If a change ever couldn’t be tied to a business — for example one made while signed out — the app used to guess which company it belonged to and send it to whatever was open, which with two businesses open could file it under the wrong one. It now never guesses. The change is held safely under Settings → Data & maintenance, showing its date, who it’s for, and amount, with a “Save to these books” button so you file it to the right company yourself. And clearing that log no longer deletes a held change you haven’t saved yet — only the server-rejected diagnostic entries.' },
  ] },
  { v: '0.71.7', items: [
    { icon: 'link', t: 'Banking flags an account your bank offers but you haven’t connected', d: 'If one of your banks is offering an account that isn’t hooked up to your books yet, its card now shows so — with a one-tap way to connect it: “Get full history” reconnects it fresh (a separate connection that pulls older months, so a few transactions you already have — mostly transfers — may appear in Review to skip), or “Just link new” adds it to an existing connection at no extra bank-feed cost. It always shows the account’s last four and asks you to confirm before linking, so a feed can’t attach on its own to the wrong account. Most of the time there’s nothing to show here — it only appears when there’s genuinely an unconnected account to pick up. Cash accounts are left alone; owner and managers only.' },
  ] },
  { v: '0.71.6', items: [
    { icon: 'content_copy', t: 'Reconnecting a bank feed no longer duplicates everything', d: 'Your bank gives each transaction an ID, but that ID belongs to the connection — not the transaction. So reconnecting an account handed back all the same transactions wearing new IDs, and the app couldn’t tell they were ones it already had. Reconnecting is exactly what we tell you to do when a start date is wrong, so the fix for one problem created another: Honey - 8002 went from 40 rows to 83, with three months listed twice. Feeds now match on the transaction itself — date, amount and description — the same way importing a statement file always has. That also means connecting a feed to an account whose statements you’ve already imported won’t bring them in a second time. Two genuinely identical transactions on the same day (two $200 ATM withdrawals, say) still both come through — they’re counted, not just matched.' },
    { icon: 'inventory_2', t: 'A large first sync can’t vanish anymore', d: 'Transactions were saved in one batch, and a batch over 500 was rejected outright — saving nothing. The app didn’t check, so it moved its bookmark past those transactions, showed a green “synced”, and told you it had added them, over an empty Review. They couldn’t be fetched again without rebuilding the feed. Now they’re saved in chunks, each one checked, the bookmark only moves past transactions that were actually saved, and a save that fails says so instead of celebrating. This mattered more once feeds started asking for two years of history instead of three months.' },
  ] },
  { v: '0.71.5', items: [
    { icon: 'error', t: 'Bank feeds now tell you when they break', d: 'If a bank feed fails, “Sync now” used to say “No new transactions” — exactly what it says when everything is fine and there’s genuinely nothing new. A feed could stop working and your books would quietly stop updating with nothing to tell you. Now a failed sync says which account failed and what to do about it, and each account on the Banking screen shows its own health: red if that feed needs attention (with the reason), amber if it hasn’t synced in over a week, green if it’s current. A dead feed can no longer show a green “synced” date. Nothing checks in the background, so the Banking screen is where you’ll see it.' },
    { icon: 'event', t: 'Connecting a feed suggests the right start date', d: 'The date box used to pre-fill today, which means “skip everything older” — and that choice is permanent, because a feed never re-offers transactions it has already skipped. Now it works it out for you: if you’ve imported statements for that account, it suggests the day after your last import (no gap, no overlap); if you haven’t, it goes back as far as your bank allows. It also warns you that the date is permanent. And from now on, connecting a feed asks your bank for up to two years of history instead of the previous three months — feeds you already connected keep the range they were created with, so re-connect one if you want its full history.' },
    { icon: 'content_copy', t: 'Review warns about duplicates before you approve', d: 'When a transfer between two of your accounts is already in your books from one account’s statement, connecting the other account’s feed brings the same transfer in again from the other side. Approving it would count the money twice, and both copies look perfectly legitimate. Those rows now carry an amber “possible duplicate” warning naming the transaction it matches, so you can skip them.' },
    { icon: 'credit_card', t: 'Credit cards can be connected to a bank feed', d: 'Bank feeds previously offered only checking and savings accounts, so a credit card could only be updated by importing statement files by hand. Credit cards can now be connected like any other account.' },
    { icon: 'schedule', t: 'A newly connected feed tells you history is still coming', d: 'Banks send the newest transactions right away and fill in older history over the following minutes. Nothing said so, so a fresh feed looked broken or empty. Connecting now tells you what arrived and that pressing “Sync now” again shortly will pull the rest — and it’s always safe to press twice, because the same transaction is never added twice.' },
  ] },
  { v: '0.71.4', items: [
    { icon: 'filter_alt_off', t: 'Less clutter on the Review screen', d: 'The “% Fee” and “⚡$ Match” buttons now appear only for businesses that take card-processor batch deposits (the salon). Those two are for splitting out a processing fee and matching a card payout to the day’s sales — they don’t apply to a business whose income is direct customer payments matched to invoices, so they’re hidden there to keep each Review row cleaner. Nothing else changes, and the buttons still work exactly the same wherever they do show.' },
  ] },
  { v: '0.71.3', items: [
    { icon: 'account_balance', t: 'Match “other income” deposits to invoices — with AI', d: 'On the “Reconcile Invoice2go to the bank” screen, the “bank deposits that aren’t Invoice2go (other income)” list now lets you match each deposit — Zelle, checks, anything paid outside Invoice2go — to the invoice it paid. Pick the invoice yourself, or hit “✨ Suggest invoice matches with AI” to have it propose one by payer name, amount, and date. Accepting a match records that deposit as income (to the same income account your Invoice2go payments use) and links it to the invoice — with a confirmation showing the account and total first. “Post all at 90%+” clears the confident ones at once, and once matched a deposit drops off the list. Deposits that aren’t invoice payments stay put — categorize those in Review as usual.' },
  ] },
  { v: '0.71.2', items: [
    { icon: 'event', t: 'AI invoice matching now weighs dates', d: 'The “✨ Suggest matches with AI” matcher now sees each invoice’s date and paid date, not just the client and amount — so it won’t suggest an invoice that’s months away from when the payment happened. Date closeness is a strong signal now: a many-months gap lowers confidence or drops the match even when the name fits (with a little slack for payments made while the document was still an estimate).' },
  ] },
  { v: '0.71.1', items: [
    { icon: 'table_view', t: 'Reconcile income table reads cleaner', d: 'On the “Reconcile Invoice2go income” screen, a picked invoice now shows its number first (e.g. “#4208 · Teena Ambrose”) instead of scrolling off to the amount, the dialog is wider so the columns aren’t cramped, and the client and amount columns are better proportioned.' },
  ] },
  { v: '0.71.0', items: [
    { icon: 'link', t: 'Match unlinked income to invoices — now with AI', d: 'On the “Reconcile Invoice2go income” screen, each unlinked payment now has a searchable invoice picker and a Link button, so you can attach it to the right invoice yourself. New “✨ Suggest matches with AI” button proposes the best invoice for every row — reading the payer’s name from the description and the amount — each with a confidence %, and a “Link all at 90%+” button clears the sure ones in one click. As always, it only suggests and you approve; linking just tags the payment to its invoice and changes no totals or fees.' },
  ] },
  { v: '0.70.11', items: [
    { icon: 'arrow_back', t: '“← Back” links now work from drill-down screens', d: 'Going back from a detail screen to its list — like “← Invoices” on the Reconcile Invoice2go screen, or backing out of a single invoice — did nothing, because the window didn’t refresh when returning to the base list. Back links now take you where they say.' },
  ] },
  { v: '0.70.10', items: [
    { icon: 'fact_check', t: 'Invoice2go reconcile no longer flags Oct’25–Feb’26 payouts', d: 'The "Reconcile Invoice2go to the bank" screen was listing every payout from before your app start date (Oct 2025–Feb 2026) as "no matching bank deposit." Those months are reconciled in QuickBooks, and the bank deposits for that period were correctly left out — but the payouts weren’t, so they could never match and showed as false exceptions. The payout list is now scoped to the same app-owned period (your import start date onward) as the deposits, so only real, current exceptions appear.' },
  ] },
  { v: '0.70.9', items: [
    { icon: 'visibility_off', t: 'The stuck red “Couldn’t send” box is gone', d: 'A styling bug left the red “Couldn’t send. Check your connection” box showing on EVERY transaction in the client app, all the time — even before you did anything, and even though your suggestions were actually sending fine. It was never a real error. The box is now correctly hidden and only appears if a suggestion genuinely fails to send.' },
  ] },
  { v: '0.70.8', items: [
    { icon: 'check_circle', t: 'Client Suggest no longer shows a false "Couldn’t send"', d: 'In the client app, sending a suggestion could show "Couldn’t send. Check your connection" even though the suggestion actually reached the owner. The cause was internal: after a successful send, refreshing the list could hiccup and get mistaken for a failed send. Sending and screen-refreshing are now separated — a successful suggestion always reports success, and if a send genuinely fails you’ll now see the real reason (and it’s logged to Settings → Diagnostics) instead of a generic connection message.' },
  ] },
  { v: '0.70.7', items: [
    { icon: 'checklist', t: 'Type-to-search then pick now actually sticks', d: 'In any Vendor or Account box, if you typed a few letters to filter the list and then clicked (or pressed Enter on) a match, your pick was being thrown away — leaving just the letters you typed as if it were a brand-new name. Now the selection sticks the moment you choose it, whether you scrolled to it or typed to find it. Typing a genuinely new name that isn’t on the list still works exactly as before.' },
  ] },
  { v: '0.70.6', items: [
    { icon: 'bug_report', t: 'The app now tells you when something quietly breaks', d: 'Back Office now captures errors automatically — even ones that don’t interrupt you — so a problem you didn’t happen to notice isn’t lost. Open Settings → Diagnostics to see them (newest first, with how many times each happened and the technical details). Turn on “Bug alerts” there to get a push notification the moment something new or serious fails (like a write the server turned down) — deduped so one glitch can’t spam you. This only adds a safety net; it never changes your books.' },
  ] },
  { v: '0.70.5', items: [
    { icon: 'view_column', t: 'Fields stop overlapping when a window is narrow', d: 'When you dragged the Review window narrow, its Vendor / Account / Invoice / Note boxes used to squeeze together until they overlapped and became unusable. They now wrap onto their own lines as the window shrinks — four across on a wide window, then two, then one — so they stay readable at any size. Windows also have a sensible minimum width now (Review and the Muse-sync Settings window are a little wider) so you can’t accidentally drag one small enough to break its contents, and the Muse-sync mapping table scrolls sideways instead of getting clipped.' },
  ] },
  { v: '0.70.4', items: [
    { icon: 'cloud_done', t: '“Saved” confirmation, and no more flashing sync warning', d: 'When a transaction or change actually reaches the server, a small green “Saved” pill briefly appears at the bottom — so you know it stuck, not just that it was entered. The orange/red bar now only shows for a real problem (you’re offline, a write was refused, or something’s been stuck more than a couple seconds), instead of flashing on every routine save. And “Sync now” now also retries anything that was previously refused, so a stuck batch is one tap to clear.' },
  ] },
  { v: '0.70.3', items: [
    { icon: 'edit', t: 'Client suggestions no longer send a partial name', d: 'In the client app, typing a brand-new vendor or account name and pressing “Suggest” while the box was still active could drop the last letter or two — e.g. “person” arrived in your Review as “perso”. The app now reads exactly what’s in the box the moment you send, so the full name always comes through (split lines too).' },
  ] },
  { v: '0.70.2', items: [
    { icon: 'check_box_outline_blank', t: 'Easier-to-see field outlines', d: 'Every fillable box — text fields, dropdowns, the inline ledger cells, date buttons, and search boxes — now has a darker, more visible outline so it’s easy to tell where you can type. The blue highlight when you click into a field is unchanged.' },
  ] },
  { v: '0.70.1', items: [
    { icon: 'cloud_off', t: 'Offline work no longer gets stuck (and you’ll know when you’re offline)', d: 'Fixed a bug where work done right after the app auto-signed-out could get queued without a business attached, which jammed the whole sync queue — so nothing after it saved, even though the little status pill still said “Synced.” Now every change is routed reliably, one bad item can never freeze the queue, and a big banner appears at the bottom of the screen whenever you’re offline or have changes waiting — with a “Sync now” button. The corner pill also shows a count (e.g. “Unsynced · 3”) so it can’t quietly say “Synced” while work is waiting.' },
  ] },
  { v: '0.70.0', items: [
    { icon: 'cloud_done', t: 'Client suggestions now reach you reliably', d: 'Fixed a timing bug where a client’s whole suggestion (account, vendor, invoice, and note) could be silently thrown away if your computer’s clock was slightly ahead of the server — the client app would say “sent” while nothing arrived in Review. Suggestions now always come through.' },
    { icon: 'call_split', t: 'Clients can suggest a split', d: 'In the client app, a “Split” button lets a client divide one transaction across several accounts, with a live balance check (just like your Review split). It shows up in Review as “Client suggested a split” — tap “Approve split” to post it as-is, or “Review split” to open the split editor pre-filled with their accounts and amounts.' },
    { icon: 'filter_list', t: 'Cleaner client Suggest screen', d: 'The client app now opens to “Needs you” (already-suggested transactions are tucked away), with a Needs you / Suggested / All switch, a progress bar, and a clear “Sent” confirmation on each row. Typed-in new vendors and accounts are held safely so they can’t get lost, and a failed send now says so instead of pretending it worked.' },
    { icon: 'edit_note', t: 'Client notes and details carry through', d: 'A client’s note now pre-fills the Note field in Review so it posts with the transaction instead of only being displayed. If a client’s suggested account was made inactive, it shows with a one-click Reactivate instead of a blank field, and “Approve all” now keeps the vendor, invoice, and note too.' },
  ] },
  { v: '0.69.61', items: [
    { icon: 'link', t: 'Link Invoice2go income to the right invoice', d: 'When a payment was made on an estimate that later became an invoice, its income got recorded but wasn’t attached to any invoice — so that invoice could look unpaid even though it wasn’t. Now the importer links these automatically by payment ID, and a new “Reconcile income” button on the Invoices tab (with a count badge) finds any that slipped through and links them in one click. Totals never change — it only connects each payment to its invoice.' },
  ] },
  { v: '0.69.60', items: [
    { icon: 'search', t: 'Search your invoices', d: 'The Invoices tab now has a search box above the list — type a client name, an invoice number, an amount, or a status (like “overdue”) to filter the list instantly. A live count shows how many match.' },
    { icon: 'unfold_less', t: 'Imports tucked into buttons', d: 'The two Invoice2go import panels no longer sit open at the top of the tab pushing your invoice list down. They’re now two buttons — “Import from Invoice2go” and “Add line items (CSV)” — that open the same form in a pop-up only when you need it, so the tab opens straight to your invoices. Importing works exactly as before.' },
  ] },
  { v: '0.69.59', items: [
    { icon: 'receipt_long', t: 'Deposits show the invoices they paid', d: 'When a deposit’s memo lists invoice numbers (e.g. “4037, 4036, 4040”), the ledger now shows each one as a clickable chip under that row — so you can see at a glance which invoices a single deposit covered, and tap one to open it. Only numbers that match a real invoice become chips.' },
  ] },
  { v: '0.69.58', items: [
    { icon: 'ads_click', t: 'Picking a vendor/account now works (client app)', d: 'The Suggest dropdowns now register your selection reliably on both desktop and tablet. (The previous attempt fixed the wrong part — this is the real fix: selections commit the instant you tap, before anything can refresh underneath them.)' },
    { icon: 'sync', t: 'Apps stay in sync on their own', d: 'The live connection now detects when it has silently dropped (idle networks/proxies do this) and reconnects + re-pulls automatically — so a change you make in the main app shows up in the client app without a manual refresh.' },
  ] },
  { v: '0.69.57', items: [
    { icon: 'ads_click', t: 'Fixed picking a vendor/account (client app)', d: 'In the client Suggest screen, the vendor/account dropdown could refresh underneath you and close before your click registered, so a selection wouldn’t stick. The list now holds still while a dropdown is open, so picks always land.' },
  ] },
  { v: '0.69.56', items: [
    { icon: 'cloud_done', t: 'Approvals save reliably (sync fix)', d: 'Fixed a timing race where approving a transaction a client had already suggested could be silently rejected by the server and left stuck in the waiting list (it would show as both posted and pending). Approvals now stick. The status badge also now shows “Unsynced” instead of “Synced” whenever something hasn’t saved, so you always know your work is safe.' },
    { icon: 'view_agenda', t: 'Cleaner Suggest layout (client app)', d: 'In the client Suggest screen, the Vendor / Account / Invoice fields no longer overlap, and the Note now has its own full-width row below them.' },
  ] },
  { v: '0.69.55', items: [
    { icon: 'call_split', t: 'Split a transaction when editing it', d: 'Open any transaction in the editor and you can now split it across several accounts — the Account section has a “＋ Add split” button that divides the amount and checks it balances to the total. Reconciled transactions and transfers keep their single account.' },
    { icon: 'palette', t: 'More behind-the-scenes color cleanup', d: 'Another internal pass routing the app’s grays, fills, and borders through one shared set of definitions. Nothing looks different.' },
  ] },
  { v: '0.69.54', items: [
    { icon: 'text_fields', t: 'Consistent input fields', d: 'Text boxes, dropdowns, the inline ledger fields, and the date button now share the same rounded corners and show the same blue highlight when you tap into them — so forms read the same everywhere.' },
  ] },
  { v: '0.69.53', items: [
    { icon: 'palette', t: 'Behind-the-scenes color cleanup', d: 'Internal tidy-up — the app’s colors now all come from one shared set of definitions. Nothing looks different; this just makes the upcoming consistency polish faster and safer.' },
  ] },
  { v: '0.69.52', items: [
    { icon: 'settings', t: 'Excel-style tables — Settings (refresh complete)', d: 'The Settings tables (change history, rejected-writes log, Muse sync mapping, the QuickBooks balance compare, and closed months) now use the blue-header, gridlined look. That completes the spreadsheet-style table refresh across the whole app.' },
  ] },
  { v: '0.69.51', items: [
    { icon: 'dashboard', t: 'Excel-style tables — Dashboard', d: 'The Bank accounts widget now uses the blue-header look, the Net and category drill-downs are accounting-aligned, and the KPI card figures line up cleanly.' },
  ] },
  { v: '0.69.50', items: [
    { icon: 'rule', t: 'Excel-style tables — Review & Deposits', d: 'Review’s tables (skipped rows, the Muse salon-synced section, and the “approve all” confirm list) and the Deposits reconciliation table now use the blue-header, gridlined look, with accounting-aligned amounts. The main list of waiting transactions keeps its card layout.' },
  ] },
  { v: '0.69.49', items: [
    { icon: 'fact_check', t: 'Excel-style tables — Reconcile', d: 'The reconcile screen and the past-reconciliations list now use the blue-header, gridlined look with accounting-aligned amounts and a navy “checked” subtotal bar.' },
  ] },
  { v: '0.69.48', items: [
    { icon: 'history', t: 'Excel-style table — Activity log', d: 'The activity / audit log now uses the blue-header, gridlined look with accounting-aligned amounts (money in green, out red).' },
  ] },
  { v: '0.69.47', items: [
    { icon: 'inventory_2', t: 'Excel-style tables — Inventory', d: 'The items list and Recent restocks now use the blue-header, gridlined look with accounting-aligned costs and values. Low-stock items still highlight in peach.' },
  ] },
  { v: '0.69.46', items: [
    { icon: 'account_balance', t: 'Excel-style tables — Banking', d: 'The import history and the CSV/bank import preview now use the blue-header, gridlined look, with accounting-aligned amounts and Title-Case descriptions in the preview. The account balance cards are unchanged.' },
  ] },
  { v: '0.69.45', items: [
    { icon: 'request_quote', t: 'Excel-style tables — Invoices', d: 'The invoice list and the invoice detail (line items, payments, the profit summary, linked expenses, and the drill-downs) now use the blue-header, gridlined look with accounting-aligned amounts. The open balance still shows in red when money is owed, and profit stays green/red.' },
  ] },
  { v: '0.69.44', items: [
    { icon: 'summarize', t: 'Reports — cleaner statements + Excel drill-downs', d: 'The Profit & Loss and Balance Sheet now have a blue header, light section bands, accounting-aligned figures, and a navy bottom-line bar (Net profit / the balanced check) — while keeping the indented accounts and bold subtotals. Clicking a line to see its transactions opens the full Excel-style table with red/green amounts. The denser “compare” and “monthly trend” views keep their compact multi-column format.' },
  ] },
  { v: '0.69.43', items: [
    { icon: 'account_tree', t: 'Excel-style tables — Accounts + registers', d: 'The Chart of accounts and the per-account / per-vendor registers now use the blue-header, gridlined look. Register amounts and running balances use the accounting alignment (in red/green by sign), with a navy total bar at the bottom.' },
    { icon: 'table_rows', t: 'Fixed the Ledger’s row striping', d: 'The alternating row shading now shows correctly in the Ledger — it was being thrown off by the hidden phone-sized detail rows under each transaction.' },
  ] },
  { v: '0.69.42', items: [
    { icon: 'text_fields', t: 'Bank descriptions read normally, not IN ALL CAPS', d: 'Imported bank descriptions now show in regular Title Case (“Amazon Business” instead of “AMAZON BUSINESS”) across the Ledger, Review, search, and the vendor/customer drill-downs. Reference numbers, dates, and short codes like ACH, NY, and CA are left alone. Display only — your stored data and matching rules are unchanged.' },
    { icon: 'table_view', t: 'Excel-style tables — Vendors & Customers', d: 'The Vendors and Customers lists now use the same blue-header, gridlined, accounting-aligned look as the Ledger.' },
  ] },
  { v: '0.69.41', items: [
    { icon: 'table_view', t: 'New Excel-style tables — Ledger + vendor/customer drill-downs', d: 'Tables are getting a cleaner spreadsheet look, rolling out tab by tab. First: the Ledger and the vendor & customer drill-downs now have a blue header with white labels, full gridlines, alternating row shading, and a navy total bar on the Ledger. Amounts use accounting alignment — the “$” sits at the left and the figures line up on the right so the decimals stack neatly, with negatives shown as a minus sign. More tabs to follow.' },
  ] },
  { v: '0.69.40', items: [
    { icon: 'view_column', t: 'Ledger details now really fit on one line', d: 'Follow-up to the last update: in a wide Ledger window the Vendor · Account · Invoice · Memo fields now lay out on a single row. The Details section is prioritized, so a long payee description wraps onto a second line rather than squeezing the fields. Narrow windows still fold the four fields back to two rows.' },
  ] },
  { v: '0.69.39', items: [
    { icon: 'devices', t: 'Simpler “Signed-in devices” list', d: 'Settings → Team & access no longer mentions approving devices — any valid PIN signs straight in, so there was nothing to approve. The list is now just “Signed-in devices” with a single Sign out button, and Sign out now genuinely ends that device’s session (its next action drops it back to the sign-in screen). They can sign back in with their PIN; to remove someone for good, remove them under Users.' },
  ] },
  { v: '0.69.38', items: [
    { icon: 'view_list', t: 'Easier-to-read Ledger', d: 'The Ledger’s column headers (Date, Payee, Details…) and the little field labels (Vendor, Account, Invoice, Memo) are now solid black instead of faint gray. The account tabs and the column header stay pinned at the top while you scroll the list, the four detail fields line up in one row when there’s room (like the Review screen), and there’s a bit more space between transactions.' },
    { icon: 'edit', t: 'Edit a transaction from a vendor’s list', d: 'Open a vendor and click any transaction in its popup to edit it — the same quick edit you get from the Reports drill-downs.' },
  ] },
  { v: '0.69.37', items: [
    { icon: 'wifi', t: 'Fewer “Offline” drops', d: 'The app now quietly keeps its live connection awake and reconnects the moment you come back to the tab or your internet returns, instead of flashing “Offline” when the connection has just been sitting idle. And if a change was still saving when you reloaded the page, it now stays on screen instead of looking like it didn’t save — which is what could lead to entering the same transaction twice.' },
    { icon: 'delete', t: 'Delete a skipped review row', d: 'Skipped rows in Review now have a Delete button next to Restore, so you can permanently remove an unwanted or duplicate bank row. A skipped row was never posted, so deleting it leaves your ledger and reports untouched.' },
  ] },
  { v: '0.69.20', items: [
    { icon: 'tune', t: 'Rule editor polish', d: 'In the make-a-rule box, the and/or selector is now wide enough to read fully (it was cut off to “a…”), and the “No transactions match yet” line no longer shows a stray “null” after it.' },
  ] },
  { v: '0.69.19', items: [
    { icon: 'edit_note', t: 'Make-a-rule shows the vendor’s existing rule', d: 'When you open “⚡ Rule” for a vendor that already has a rule, the modal now loads that rule — its match conditions, and/or connectors, account, and amount limits — instead of starting blank, so you can see and edit it. Saving updates the existing rule (removing a condition now sticks).' },
  ] },
  { v: '0.69.18', items: [
    { icon: 'backspace', t: 'Clear a vendor or account back to blank', d: 'In any of the type-to-search boxes (vendor, account, category, invoice), you can now erase your pick: clear the text and click away (or press Tab/Enter) and the field goes back to blank. It only clears when you’ve actually emptied the box, so it won’t happen by accident.' },
  ] },
  { v: '0.69.17', items: [
    { icon: 'format_align_left', t: 'Fixed overlapping text in search results', d: 'In the global search, a transaction’s date no longer runs into its description — the date column now sizes to fit, so the date, description, and amount stay in clean columns.' },
  ] },
  { v: '0.69.16', items: [
    { icon: 'fact_check', t: '“Approve all” now asks you to confirm', d: 'Clicking “Approve all categorized” no longer posts everything instantly. It first shows a list of every transaction and the account it’ll be posted to, so you can look it over and confirm — or cancel — before anything hits the ledger.' },
  ] },
  { v: '0.69.15', items: [
    { icon: 'call_split', t: 'Split a transaction in Review', d: 'Each waiting transaction now has a “⊟ Split” button. It opens a window where you divide the amount across two or more accounts (e.g. one charge that’s part supplies, part office) — a running total shows what’s left to assign, and it posts as one balanced transaction once the pieces add up.' },
  ] },
  { v: '0.69.14', items: [
    { icon: 'rule', t: 'Choose “and” or “or” for each rule condition', d: 'When a vendor rule has more than one match condition, each extra one now has an “and / or” picker, so you can say “contains A and contains B” (both required) or “contains A or contains B” (either one). “and” groups tighter than “or” (A and B or C means “(A and B) or C”). This also clears up the old behavior, where plain multi-word rules quietly acted like “or.”' },
    { icon: 'restart_alt', t: 'Making a rule no longer wipes the invoice/note', d: 'In Review, if you’d filled in an invoice or a note and then made a rule, they used to disappear when the row refreshed. Now creating a rule only fills in the vendor and account it memorized — your invoice and note stay exactly as you left them.' },
  ] },
  { v: '0.69.13', items: [
    { icon: 'space_bar', t: 'Roomier “Auto-categorize vendor” box', d: 'The make-a-rule pop-up is now grouped into clear sections — Vendor name, Match conditions, Account, and the matches preview — with space and a thin line between each, so it’s much easier to read.' },
    { icon: 'segment', t: 'Search results grouped by type, in columns', d: 'The top search now splits transactions into their own headings by type — Transfers, Deposits, Expenses, Card payments, Checks, and so on — and lines up date, payee, and amount in neat columns.' },
    { icon: 'filter_list', t: 'Filter your search', d: 'A small filter bar at the top of the search results lets you narrow transactions by account, by category, or by date (this month / this year / last 90 days).' },
  ] },
  { v: '0.69.12', items: [
    { icon: 'view_column', t: 'Tidier Review rows', d: 'In Review (and the client Suggest screen), each row is now two clean columns: the description and the Vendor/Account/Invoice/Note fields on the left, and the match chip, amount, and action buttons on the right. The description now wraps to end exactly where the Note column ends, and the amount stays pinned far right — so everything lines up straight down the page.' },
  ] },
  { v: '0.69.11', items: [
    { icon: 'format_align_right', t: 'Amounts line up in a fixed column', d: 'In Review (and the client Suggest screen), the dollar amount now always sits in the same spot on the far right, with the match chip just to its left — so your eye can scan straight down the amounts no matter how long the description or label is.' },
  ] },
  { v: '0.69.10', items: [
    { icon: 'manage_accounts', t: 'Edit and remove users', d: 'In Settings → Team & access you can now Edit a user (rename, change their role, or reset their PIN) and Remove them. Removing a user takes away their access right away; if they don’t belong to any other business, their login is deleted entirely. You can’t remove the owner or yourself.' },
    { icon: 'filter_alt', t: 'Client app: search & filters', d: 'The client “Suggest” screen now has a search box (by description, amount, or vendor) and filters for status (needs a suggestion vs. already suggested) and money in vs. out — so a bookkeeper can work through a long list quickly.' },
  ] },
  { v: '0.69.9', items: [
    { icon: 'dashboard_customize', t: 'Settings is now a tidy menu', d: 'Instead of one long page, Settings is a short menu — Team & access, Modules, QuickBooks, Integrations, Close the books, and Data & maintenance. Click any one and it opens in its own window (like every other tab), so you can keep, say, QuickBooks and Users open side by side. The four QuickBooks tools now live together under “QuickBooks.”' },
  ] },
  { v: '0.69.8', items: [
    { icon: 'flip_to_front', t: 'Clicking a tab brings its window to the front', d: 'If a window is already open, clicking its tab again now raises it (and un-minimizes it) instead of doing nothing — no more hunting for it in the “Open windows” bar.' },
    { icon: 'table_rows', t: 'Reconcile: separate Payments and Deposits columns', d: 'The reconcile list now splits money out (Payments) and money in (Deposits) into their own columns, with a running subtotal of each at the bottom that adds up the items you’ve checked — so you can tie each side to your statement’s totals.' },
    { icon: 'straighten', t: 'Reconcile: tidied the top row', d: 'The statement end-date field now lines up evenly with the account and ending-balance fields.' },
  ] },
  { v: '0.69.7', items: [
    { icon: 'sync', t: 'Sync your accounts & vendors to QuickBooks', d: 'New in Settings → “Sync lists to QuickBooks”: download one .iif file that pushes your full chart of accounts AND vendor list into QuickBooks Desktop (File → Utilities → Import → IIF Files). It creates anything new and updates names/types on what’s already there — no duplicates. Because a file can’t rename, merge, or inactivate in QuickBooks, the screen shows a short checklist of exactly those changes since your last sync (e.g. “Rename account X → Y”, “Merge A into B”). Hit “Mark as synced” once you’ve done it, and next time you’ll only see what changed since. The app stays the source of truth; QuickBooks just follows.' },
  ] },
  { v: '0.69.6', items: [
    { icon: 'edit', t: 'Edit a reconciled transaction’s account & vendor', d: 'Reconciled transactions used to lock the account. Now you can still change the account (and vendor) on them — the date and amount stay locked because those are what was matched to your bank statement, but the account/category never affects that, so it’s safe to fix. (A transfer between two of your own accounts stays fully locked while reconciled.)' },
    { icon: 'search', t: 'Search the Chart of accounts', d: 'A search box at the top of Chart of accounts filters the list by account name (or QuickBooks name) as you type.' },
    { icon: 'call_merge', t: 'Clearer merge — see exactly what moves', d: 'When you merge a vendor, customer, or account, the confirmation now spells out how many transactions will move and states plainly that nothing is deleted — they’re just re-pointed to the one you keep. (Merge lives on each account’s row in Chart of accounts, and the “Merge…” button inside a vendor’s or customer’s pop-up.)' },
  ] },
  { v: '0.69.5', items: [
    { icon: 'swap_vert', t: 'Sort the Vendors & Customers lists by any column', d: 'Vendors and Customers now start sorted alphabetically, and you can click any column heading — Vendor/Customer, Rule, Transactions, Total — to sort by it. Click again to flip between ascending and descending. The transaction lists inside a vendor’s or customer’s pop-up sort the same way (by date, description, account, or amount).' },
  ] },
  { v: '0.69.4', items: [
    { icon: 'keyboard_tab', t: 'Adding a vendor keeps you on the keyboard', d: 'After you type a new vendor name and press Enter to add it (in Review or when adding/editing a transaction), the focus now returns to the vendor box with the new vendor filled in — so you can press Tab to move to the next field without reaching for the mouse.' },
  ] },
  { v: '0.69.3', items: [
    { icon: 'manage_search', t: 'Type to search every account / vendor / invoice picker', d: 'You can now just start typing to find an account, vendor, or invoice in the dropdowns throughout the app — in the Ledger filter, when adding or editing a transaction, in journal entries, and in the inline boxes on each ledger row. No more scrolling a long list: type a few letters and it narrows down. New accounts and vendors can still be added right from the same box.' },
  ] },
  { v: '0.69.2', items: [
    { icon: 'open_in_full', t: 'Resize any pop-up window', d: 'Pop-up windows (like a vendor’s transaction list) were stuck at one width. Now you can drag the right edge to make any of them wider or narrower — handy when a transaction description or account name is getting cut off.' },
    { icon: 'search', t: 'Search by dollar amount', d: 'The top search bar now finds transactions by their amount, not just their description. Type “190.64” (or “$1,988.10”) and the matching transaction comes up even if the amount isn’t written in the description.' },
    { icon: 'fact_check', t: 'Search now includes Review transactions', d: 'Transactions still waiting in your Review tab now show up in the top search too, under an “In Review” heading. Clicking one opens Review filtered to it.' },
  ] },
  { v: '0.69.1', items: [
    { icon: 'arrow_drop_down_circle', t: 'Drop-downs stop jumping and are wider', d: 'When you open an account or vendor drop-down in Review, the list behind it no longer scrolls or jumps around — the menu now floats on top of the window, opens upward if it’s near the bottom, and is wide enough to show most account names on a single line.' },
    { icon: 'keyboard_return', t: 'Press Enter to add a new vendor', d: 'In the “Add vendor” pop-up you can now just press Enter to add it — no need to reach for the mouse.' },
    { icon: 'sync_alt', t: 'Switching the vendor updates the account', d: 'On a Review row, if you change the vendor to one that has a memorized account, the account now switches to match it too — even if an account was already filled in.' },
    { icon: 'notes', t: 'No more drop-down on Notes', d: 'The Note/memo box is now plain free-text with no autocomplete drop-down getting in the way. (The Payee field still suggests names.)' },
  ] },
  { v: '0.69.0', items: [
    { icon: 'group_add', t: 'New: a Client workspace', d: 'You can now give a bookkeeper/assistant their own simple app (client.html). In Settings → Users, create a user with the new “Client” role and give them the link + their PIN. They can suggest a vendor, account and invoice on each waiting transaction and leave you a note — but nothing posts; it all comes to your Review pre-filled with a “💬 Client suggested” badge and their note, for you to approve. They can also view Invoices (with per-invoice net profit) and Reports, read-only. They can’t import, edit the books, add vendors, or export.' },
  ] },
  { v: '0.68.25', items: [
    { icon: 'call_merge', t: 'Merge duplicate vendors, customers & accounts', d: 'Open a vendor or customer (or an account in the Accounts list) and use “Merge…” to fold a duplicate into another one — all its transactions move over and the duplicate is removed (accounts are archived, and a merge is blocked if it touches a closed month). Delete is still there for vendors and customers.' },
    { icon: 'auto_awesome', t: 'AI now fills in the vendor too', d: 'Get AI suggestions now also reads a clean vendor/payee name out of each bank description (e.g. “POS DEBIT NETFLIX COM LOS GATOS CA” → “Netflix”). It reuses a vendor you already have when it matches, and otherwise pre-fills the name and creates the vendor when you approve — so your vendor list builds itself from your transactions.' },
    { icon: 'visibility', t: 'See all your rules + clearer Review dates', d: 'The Vendors tab has a “Rules only” checkbox to list just the vendors that have an auto-categorize rule or a memorized account. And the date on each Review row is now dark and easy to read.' },
  ] },
  { v: '0.68.24', items: [
    { icon: 'tune', t: 'Review & rules: lots of small wins', d: 'Review’s title, description, search and filters now stay fixed at the top while only the rows scroll. In a Review row the fields are reordered to Vendor → Account → Invoice → Note, the chosen account is easier to read (full name on hover, and the field scrolls to show child-account names), and picking a vendor that has a memorized account fills the account in for you. The Invoice field is now type-to-search by number or customer. The “saved” confirmation always shows on top now.' },
    { icon: 'edit', t: 'Edit transactions from vendor/customer drill-downs + searchable rule accounts', d: 'In a vendor or customer drill-down, each transaction now has an Edit button that opens the full editor (amount, date, splits, delete). The Edit-rule account box lets you type to search instead of scrolling. And you can now save a rule that just maps a vendor to an account — no description match required.' },
  ] },
  { v: '0.68.23', items: [
    { icon: 'flip_to_front', t: 'Windows stay below the menus; search jumps to the transaction', d: 'The top search bar, the hover-open sidebar, and pop-ups now always sit above your windows — no window can hide them anymore, no matter how many you’ve clicked through. Clicking a transaction in the global search now opens the Ledger filtered to it. And Escape is now smarter: it closes an open autofill/drop-down first, then a pop-up — and only closes the window when nothing else is open and you’re not typing in a field.' },
  ] },
  { v: '0.68.22', items: [
    { icon: 'select_window', t: 'Window polish: flush headers + resize any edge', d: 'Inside a window, the sticky header of a tab (like Review’s title/search/filters) now pins flush to the top — no more empty band above it, and rows no longer scroll up behind it into a gap. And you can now resize a window from any edge or corner — top, bottom, left, right, or the four corners — not just the bottom-right.' },
  ] },
  { v: '0.68.21', items: [
    { icon: 'select_window', t: 'Tabs are now movable windows (QuickBooks-style)', d: 'Each tab opens as its own window in the workspace — open several at once and stack them. Drag a window by its title bar, resize from the bottom-right corner, and use the title-bar buttons to minimize (to the “Open windows” bar at the bottom), maximize/restore to full screen, or close. Clicking a tab that’s already open just brings its window to the front. Double-click a title bar to maximize.' },
  ] },
  { v: '0.68.20', items: [
    { icon: 'menu', t: 'Collapsed menu — no more text sliver', d: 'When the sidebar is collapsed to the icon rail, the menu labels are now fully hidden (and centered icons only) instead of leaving a distracting sliver of text peeking past the edge. Hover the rail to see the full labels as before.' },
  ] },
  { v: '0.68.19', items: [
    { icon: 'rule', t: 'Smarter rules: vendor-only + “does not contain”', d: 'When making a rule, the account is now optional — leave it blank to just memorize the vendor for matching descriptions and pick the account yourself each time (matching rows show a “⚡ Vendor · pick account” tag). Rules also gained a “does not contain” condition, so you can match things like “AMZN but NOT Prime.”' },
  ] },
  { v: '0.68.18', items: [
    { icon: 'drag_pan', t: 'Pop-ups are now movable windows', d: 'Every dialog now works like a file-explorer window — grab its title bar and drag it anywhere on the screen so you can see (and read) whatever is behind it. The dark dimming behind dialogs is gone too, so the rest of the app stays visible while a dialog is open.' },
  ] },
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
