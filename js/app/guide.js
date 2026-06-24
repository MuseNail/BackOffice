// ── Guide — printable in-app documentation (Full + Quick reference) ────────────
// Opens a self-contained, print-friendly document in a new tab; "Print / Save as
// PDF" produces the PDF. Kept in code (not a committed binary) so it never drifts
// from the app. The full guide and the one-page quick reference share styling.

const STYLE = `
*{box-sizing:border-box}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1c1c1c;max-width:820px;margin:0 auto;padding:0 24px 64px}
.bar{position:sticky;top:0;background:#fff;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #ddd;margin-bottom:14px}
.bar button{background:#1f9d63;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}
h1{font-size:25px;margin:14px 0 2px}
h2{font-size:19px;margin:26px 0 6px;border-bottom:2px solid #eee;padding-bottom:4px}
h3{font-size:15.5px;margin:16px 0 3px}
p{margin:6px 0}ul,ol{margin:5px 0 5px 20px;padding:0}li{margin:3px 0}
.sub{color:#666;font-size:13px;margin-top:0}
code{background:#f1f1f1;border-radius:4px;padding:1px 5px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{border:1px solid #dcdcdc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7}
.step{background:#f6faf7;border:1px solid #d7ece0;border-radius:8px;padding:10px 14px;margin:8px 0}
.tag{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700}
@media print{.bar{display:none}body{max-width:none;padding:0}}
@page{margin:1.4cm}
`;

function openDoc(title, html) {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to open the guide.'); return; }
  w.document.write(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>${STYLE}</style></head><body>` +
    `<div class="bar"><strong>${title}</strong><button onclick="window.print()">Print / Save as PDF</button></div>` +
    html + `</body></html>`);
  w.document.close();
}

export function openGuide() { openDoc('Back Office — App Guide', FULL); }
export function openQuickRef() { openDoc('Back Office — Quick Reference', QUICK); }
export function openProcedure() { openDoc('Back Office — Bank & Invoice2go Procedure', PROCEDURE); }

// ── Full guide — the detailed manual: every tab, button, symbol, and color ─────
const FULL = `
<h1>Back Office — App Guide</h1>
<p class="sub">The complete manual for the cloud bookkeeping app: what every tab does, what each button does when you click it, what every symbol and color means, and how text fields behave. Back Office keeps a full double-entry set of books for one or more businesses — you bring money activity in, review and categorize it, and it posts to a ledger that drives your Profit &amp; Loss and Balance Sheet. <strong>Nothing posts to your books until you approve it.</strong></p>

<h2>How to read the screen</h2>

<h3>Symbols &amp; icons</h3>
<table>
<tr><th>Symbol</th><th>Where</th><th>Meaning &amp; what clicking it does</th></tr>
<tr><td><strong>⚡</strong></td><td>Review — on a row</td><td>Make a <strong>rule</strong>: opens a box to auto-categorize this vendor on future imports. A rule can point at an income/expense account <em>or</em> an account transfer.</td></tr>
<tr><td><strong>%</strong></td><td>Review — on a deposit (money-in) row</td><td><strong>Deposit with a processing fee</strong>: you enter the gross sales the payout covers, and it posts gross income, the fee as an expense, and the net to the bank — one balanced entry.</td></tr>
<tr><td><strong>⚡$</strong></td><td>Review — on a deposit row</td><td><strong>Match deposit</strong>: matches a bank deposit to your recorded sales/payments and relieves the clearing account (used for Invoice2go and the salon's card deposits) so nothing double-counts.</td></tr>
<tr><td><strong>✨</strong></td><td>Review — top toolbar</td><td><strong>Get AI suggestions</strong>: asks Claude to categorize the rows that have no rule/history match. It only <em>suggests</em> — you still approve each one. While it runs it shows "✨ Asking Claude…".</td></tr>
<tr><td><strong>↔</strong></td><td>Account dropdowns</td><td>Marks the "<strong>Transfer to / from</strong>" group — picking one of these accounts records a movement <em>between your own accounts</em> (never income or expense).</td></tr>
<tr><td><strong>🕘</strong></td><td>Review — suggestion chip</td><td>"You did this before" — the account was matched from your own posting history.</td></tr>
<tr><td><strong>＋</strong></td><td>Dropdowns &amp; toolbars</td><td>Add something new inline — e.g. "＋ Add account…" in a dropdown opens a quick-add box; "＋ New invoice" / "＋ Add line" add records/rows.</td></tr>
<tr><td><code>↻</code></td><td>Version badge</td><td>An update is ready — click to reload to the latest version. "Hard reset" in your name menu does the same on demand (clears the cache and reloads; your data is safe).</td></tr>
<tr><td>Outline line-icons</td><td>Left nav &amp; your-name menu</td><td>Decorative labels for each tab/menu item — they do whatever their label says.</td></tr>
</table>

<h3>Color codes</h3>
<p>Colors are used consistently as small <strong>pills</strong> (status chips) and on amounts. The five pill colors mean:</p>
<table>
<tr><th>Color</th><th>Means</th><th>Examples</th></tr>
<tr><td><span class="tag" style="background:#dbe7fb;color:#1c4e9c">Blue</span></td><td>From a <strong>rule</strong> or an <strong>import</strong></td><td>Review: "⚡ Rule · <em>vendor</em>". Ledger source tags: "CSV", "Bank", "QuickBooks".</td></tr>
<tr><td><span class="tag" style="background:#fbeccb;color:#8a5a00">Amber</span></td><td><strong>AI</strong> or <strong>needs attention</strong></td><td>Review: "✨ AI · <em>NN%</em>". Banking: "<em>N</em> in Review". Settings: "AI is paused" / "budget reached".</td></tr>
<tr><td><span class="tag" style="background:#d6f0e0;color:#1f7a4d">Green</span></td><td><strong>Good / done</strong></td><td>Invoices: "Paid". History match. Sync pill: "Synced". Positive amounts. Ledger "Manual" source.</td></tr>
<tr><td><span class="tag" style="background:#f7d6d6;color:#b23030">Red</span></td><td><strong>Problem / attention</strong></td><td>Invoices: "Open" balance. Review: "Map in Settings". Negative amounts. A reconciliation that isn't balanced.</td></tr>
<tr><td><span class="tag" style="background:#eef0f4;color:#5b5e68">Gray</span></td><td><strong>Neutral / inactive</strong></td><td>Review: "No match". Ledger: "Void". A skipped row. An off/unconfigured feature.</td></tr>
</table>
<p><strong>Amounts</strong> are colored too: <span class="tag" style="background:#d6f0e0;color:#1f7a4d">green</span> = money in (positive), <span class="tag" style="background:#f7d6d6;color:#b23030">red</span> = money out (negative). <strong>Invoice status:</strong> Paid (green) = fully paid · Partial (amber) = part-paid · Open (gray) = nothing paid yet. The <strong>Reconcile</strong> difference turns green only when it reaches exactly $0.00.</p>

<h3>Text fields &amp; formatting</h3>
<p>Every text field — payee, memo, account/vendor names, invoice line descriptions, notes — is <strong>plain text only</strong>. <strong>Nothing renders Markdown or HTML.</strong> What you type is stored and shown exactly as typed, so symbols like <code>*</code> or <code>#</code> appear literally. (Money is always stored as exact cents and only formatted for display, so amounts never drift.)</p>

<h2>Signing in &amp; getting around</h2>
<ul>
<li><strong>Sign in</strong> with your login name and PIN. Your role — <strong>owner / manager / bookkeeper / viewer</strong> — controls what you can change (viewers are read-only).</li>
<li>A <strong>new device</strong> may need approval before it can sign in (Settings → Devices, from a device that's already signed in).</li>
<li><strong>Businesses</strong> (left nav) — owners and multi-business users switch between sets of books here; a single-business user lands straight in their books and won't see this.</li>
<li><strong>Your name (top-right)</strong> → <strong>App guide</strong>, <strong>Quick reference</strong>, <strong>What's new</strong>, <strong>Hard reset</strong>, <strong>Log out</strong>.</li>
<li>The <strong>Synced / Offline</strong> pill shows the live connection; offline edits catch up when you reconnect.</li>
</ul>

<h2>The tabs</h2>

<h3>Dashboard</h3>
<p>At-a-glance health: cash position (sum of bank accounts), this month's income / expenses / net, and how many rows are waiting in Review. If the books are empty it shows links to <strong>Banking</strong> and <strong>Accounts</strong> to get started.</p>

<h3>Banking</h3>
<ul>
<li>One card per bank/credit-card account, with its balance and a status pill ("Up to date" green, or "<em>N</em> in Review" amber).</li>
<li><strong>Add bank account</strong> — name, type (Checking / Savings / Credit card / Cash), and institution.</li>
<li><strong>Import CSV</strong> — bring in a statement: it auto-detects the date / description / amount columns, <strong>skips rows you've already imported</strong>, and stages the rest into Review.</li>
<li><strong>Connect feed</strong> — links the bank via Plaid so transactions arrive automatically. <strong>Sync now</strong> pulls the latest; <strong>Disconnect</strong> removes the feed (rows already in Review stay).</li>
<li>An <strong>import history</strong> table shows each past import (file, rows, duplicates skipped, how many are still pending).</li>
</ul>

<h3>Review — the approval desk</h3>
<p>Imported rows wait here, grouped by account. <strong>Approving a row is the moment money posts to your books.</strong></p>
<ul>
<li><strong>Toolbar:</strong> filters for money <em>in/out</em>, <em>needs an account</em> vs <em>ready</em>, by account, and sort (newest / oldest / largest / smallest); a <strong>Reset</strong> appears when a filter is on. <strong>Approve all categorized</strong> posts every row that already has an account. <strong>✨ Get AI suggestions</strong> categorizes the unmatched rows (you still approve each).</li>
<li><strong>Account dropdown</strong> (per row): a "↔ Transfer to / from" group (your bank/card accounts), then your accounts grouped by type (sub-accounts are indented), then "<strong>＋ Add account…</strong>" which opens a quick-add box without losing your place.</li>
<li><strong>Suggestion chip</strong>: "⚡ Rule · <em>vendor</em>" (blue), "✨ AI · <em>NN%</em>" (amber), "🕘 You did this before" (green), or "No match" (gray).</li>
<li><strong>Approve</strong> — posts the row to the ledger with the chosen account. <strong>Skip</strong> — sets it aside (it moves under "Show skipped," where <strong>Restore</strong> brings it back); nothing is deleted and skipped rows still count for de-duplication.</li>
<li><strong>⚡</strong> make a rule · <strong>%</strong> deposit-with-fee · <strong>⚡$</strong> match deposit (the last two appear only on money-in rows). See the symbols table.</li>
<li>Transfers between your own accounts are recognized and never counted as income or expense; the matching row on the other account is cleared automatically.</li>
<li>If your business receives the <strong>Muse salon sync</strong>, salon rows show in their own "Muse — synced from the salon" section. Each posts via the mapping set in Settings; a row marked "<strong>Map in Settings</strong>" (red) needs a balancing account first.</li>
</ul>

<h3>Invoices (accounts receivable)</h3>
<p>Shown only for businesses with the Invoices feature on (Settings → Business features).</p>
<ul>
<li><strong>Import from Invoice2go</strong> — upload the weekly CSV and set a <strong>cutoff date</strong> (only invoices with a payment on/after it are imported). It de-dupes, so re-importing the full weekly export only adds new invoices and new payments.</li>
<li><strong>＋ New invoice</strong> — enter one by hand (client, invoice #, date, email, line items) with a live total. Manual invoices can be edited, paid, and deleted; imported ones stay read-only so a re-import never overwrites your edits.</li>
<li>The list shows each invoice's <strong>total / paid / open balance</strong> with a status pill, KPI cards (open balance, open count, collected), and an <strong>A/R aging</strong> breakdown (Current / 1–30 / 31–60 / 61–90 / 90+). Click an invoice to see line items and payments.</li>
<li><strong>Post payments to the ledger</strong> — pick an income account, a clearing account, and a fee account ("<strong>Create the standard clearing + fee accounts</strong>" makes them in one click). Each paid payment posts as income through the clearing account with the fee expensed. It's idempotent — already-posted payments are skipped — so run it after each weekly import.</li>
<li><strong>Record payment</strong> (on a manual invoice) logs a hand-taken payment and posts it through the same flow.</li>
</ul>

<h3>Ledger</h3>
<ul>
<li>Every posted transaction. <strong>Search</strong> payee/memo; filter by date / account / vendor / source; click any column heading to <strong>sort</strong>.</li>
<li>A <strong>source tag</strong> shows where each came from — Manual, CSV, Bank, QuickBooks, or Muse. A <strong>Reconciled</strong> pill means it's locked.</li>
<li><strong>Add transaction</strong> — a simple one-line entry (bank account, the account it posts to, and the amount). <strong>Journal entry</strong> — a multi-line entry that must balance to zero.</li>
<li>Per row: <strong>Edit</strong> details, <strong>Void</strong> (zeros it out but keeps the record — the only way to undo a posted entry), or <strong>Delete</strong>. Voiding/deleting is blocked on <strong>reconciled</strong> transactions and inside a <strong>locked period</strong> — reopen the period first.</li>
</ul>

<h3>Accounts (chart of accounts)</h3>
<ul>
<li>Every account your money flows through, grouped by type (Income, Cost of goods, Expenses, Assets, Liabilities, Equity).</li>
<li><strong>Add account</strong>, <strong>Edit</strong>, or <strong>Archive</strong> (archived accounts keep their history but leave the pickers; <strong>Show archived</strong> reveals them and <strong>Restore</strong> brings one back).</li>
<li>Click an account name to open its <strong>register</strong> — every transaction hitting it with a running balance, and an <strong>Export CSV</strong> button.</li>
</ul>

<h3>Vendors &amp; rules</h3>
<p>Vendors carry the auto-categorize rules used in Review. <strong>New rule</strong> / <strong>Edit</strong> sets the match (an exact description or a keyword that "appears anywhere") and the account it should suggest (a normal account <em>or</em> an account transfer). <strong>Delete</strong> stops future suggestions (already-posted transactions are untouched). Click a vendor for a <strong>register</strong> of all its transactions, with CSV export. Exact match wins over keyword; a rule pointing at an archived account is flagged.</p>

<h3>Reconcile</h3>
<p>Pick a bank account, the statement end date, and the statement ending balance; <strong>tick off</strong> the cleared transactions. The <strong>difference</strong> must reach exactly <strong>$0.00</strong> (it turns green) before <strong>Close &amp; lock these in</strong> finalizes it. Reconciled transactions are protected forever — their amounts, accounts, and status can't change afterward. Past reconciliations are listed below.</p>

<h3>Deposits</h3>
<p>Shown only for the salon (Muse sync). A per-day comparison of what Muse recorded vs. what the processor (Helcim) reported, so card-deposit fee/settlement gaps are easy to spot. Pick a date range and load.</p>

<h3>Inventory</h3>
<p>Track items (name, unit, cost, restock point) and record <strong>restocks</strong> (which post a linked transaction). A simple shopping list lets you add ad-hoc supplies and print it.</p>

<h3>Reports</h3>
<p><strong>Profit &amp; Loss</strong> and <strong>Balance Sheet</strong> for a date range (with an "as of" date for the Balance Sheet). Pick a preset range, <strong>drill into</strong> any line to its register, and use <strong>Print</strong> (PDF) or <strong>Export CSV</strong> on the toolbar.</p>

<h3>Settings</h3>
<p>Owner/manager only. The cards:</p>
<ul>
<li><strong>Users</strong> — list of this business's users; <strong>Add user</strong> (name, login name, PIN, role).</li>
<li><strong>Devices</strong> — <strong>Approve</strong> a pending device or <strong>Remove</strong> one.</li>
<li><strong>Business features</strong> — toggles for <strong>Invoices / accounts receivable</strong> and <strong>Muse salon sync</strong>; turning one off only hides its tab(s) — it never deletes data, so turning it back on brings everything back.</li>
<li><strong>AI usage &amp; spending</strong> — this month's and lifetime spend; set a <strong>monthly budget</strong> (blank = no cap) and a <strong>Pause</strong> switch. Both are enforced on the server before any spend.</li>
<li><strong>Muse sync</strong> (when on) — map each salon row type to a balancing account and a suggested account, then <strong>Save mapping</strong>.</li>
<li><strong>QuickBooks Desktop export</strong> — pick a date range and <strong>Export .iif</strong>; if some transactions were exported before, it warns so you don't double them in QuickBooks.</li>
<li><strong>Import chart of accounts (.IIF)</strong> — bring a client's QuickBooks accounts in; existing ones are skipped, so re-importing is safe.</li>
<li><strong>Close the books</strong> — pick a month and <strong>Close month</strong> to lock it: a locked month rejects new postings <em>and</em> edits/deletes of posted entries (QuickBooks re-exports still work). Locked months are listed with a <strong>Reopen</strong> button.</li>
<li><strong>Rejected writes</strong> — a log of any write the server turned down (a stale or blocked edit) so nothing is silently lost; <strong>Clear all</strong> removes the log for this business.</li>
</ul>

<h2>Core workflows</h2>
<div class="step"><strong>Weekly bank bookkeeping:</strong> Banking → Import CSV (or Sync now) → Review → categorize / approve (use ⚡ to build rules, % or ⚡$ for deposits with fees) → check Reports.</div>
<div class="step"><strong>Invoice2go A/R:</strong> Invoices → Import the weekly CSV (cutoff date) → Post payments to the ledger → import your bank CSV in Banking → in Review, ⚡$ match the deposits → watch the Invoice2go Clearing account register settle toward $0.</div>
<div class="step"><strong>Month-end:</strong> finish Review → Reconcile each account against its statement and lock → Close the month (Settings) → Reports (P&amp;L + Balance Sheet) → Export/Print, or QuickBooks .IIF export.</div>
<div class="step"><strong>New client setup:</strong> create the business (answer whether it uses invoices) → Settings → import their QuickBooks chart of accounts (.IIF) → connect/import bank activity → set vendor rules as you categorize.</div>

<h2>Good to know</h2>
<ul>
<li>Nothing posts to your books automatically — Review/approval is always the gate.</li>
<li>Re-imports are safe: bank rows, Invoice2go invoices/payments, and QuickBooks accounts all de-dupe.</li>
<li>Reconciled transactions and locked-period entries are protected from edits <em>and</em> deletes.</li>
<li>Each business is walled off from every other one; your role limits what you can change.</li>
</ul>
`;

// ── Quick reference — the everyday overview (was the old App Guide) ─────────────
const QUICK = `
<h1>Back Office — Quick Reference</h1>
<p class="sub">Cloud bookkeeping for your businesses — every tab, the key buttons, and the workflows they support, in brief. (For exact button-by-button detail, every symbol, and color meanings, see the full App guide.)</p>

<h2>What Back Office is</h2>
<p>Back Office keeps a full double-entry set of books for one or more businesses. You bring money activity in (bank CSVs, a bank feed, the Invoice2go import, or the Muse salon sync), review and categorize it, and it posts to a ledger that drives your Profit &amp; Loss and Balance Sheet. Nothing posts to your books until you approve it.</p>

<h2>Signing in &amp; switching businesses</h2>
<ul>
<li>Sign in with your name and PIN. Your role (owner / manager / bookkeeper / viewer) controls what you can change.</li>
<li>Owners and multi-business users see <strong>Businesses</strong> to switch between sets of books. Single-business users land straight in their books.</li>
<li>Top-right: your name. Tap it for the <strong>App guide</strong>, <strong>Quick reference</strong>, <strong>What's new</strong>, <strong>Hard reset</strong>, and <strong>Log out</strong>.</li>
<li>When an update is available the version shows a <code>↻</code> — tap to reload. "Hard reset" does the same on demand (clears the app cache and reloads; your data is safe).</li>
</ul>

<h2>The tabs</h2>

<h3>Dashboard</h3>
<p>At-a-glance health of the business — recent activity and key numbers. Your starting point.</p>

<h3>Banking</h3>
<ul>
<li>Holds your bank &amp; credit-card accounts. <strong>Import CSV</strong> to bring in a statement: it auto-detects the date / description / amount columns, skips rows you've already imported, and stages the rest for Review.</li>
<li><strong>Connect feed</strong> links a bank via Plaid so transactions arrive automatically; <strong>Sync now</strong> pulls the latest; <strong>Disconnect</strong> removes a feed.</li>
</ul>

<h3>Review</h3>
<p>The approval desk — imported rows wait here, grouped by account. <strong>Approval is the moment money posts to your books.</strong></p>
<ul>
<li>Each row shows a suggested account (from your vendor rules, then your history, then AI). Pick or confirm an account and <strong>Approve</strong>.</li>
<li><strong>⚡</strong> turns a row into an auto-categorize rule for that vendor going forward (income/expense accounts <em>and</em> account transfers).</li>
<li><strong>%</strong> records a deposit that had a processing fee taken out (posts gross income, the fee as an expense, and the net to the bank in one balanced entry).</li>
<li><strong>⚡$</strong> matches a deposit to your recorded sales/payments and relieves the clearing account (used for Invoice2go and the salon's card deposits).</li>
<li><strong>Skip</strong> sets a row aside without posting — it moves to "Show skipped," where <strong>Restore</strong> brings it back. Nothing is deleted, and skipped rows still count for de-duplication.</li>
<li>Filter/sort the queue (money in/out, needs-an-account vs ready, by account, newest/largest). <strong>Approve all categorized</strong> posts everything that already has an account. <strong>✨ Get AI suggestions</strong> asks Claude to categorize the unmatched rows (you still approve each).</li>
<li>Transfers between your own accounts are recognized and never counted as income or expense.</li>
</ul>

<h3>Invoices (accounts receivable)</h3>
<ul>
<li><strong>Import from Invoice2go</strong>: upload the weekly invoice CSV. Set the cutoff date (only invoices with a payment on/after it are imported). It de-dupes, so re-importing the full weekly export only adds new invoices and new payments.</li>
<li><strong>＋ New invoice</strong>: enter an invoice by hand — client, date, line items — with a live total. Manual invoices can be edited, paid, and deleted; imported ones stay read-only so a re-import never overwrites your edits.</li>
<li>The list shows each invoice's total, paid, and <strong>open balance</strong>, plus KPIs and an <strong>A/R aging</strong> breakdown (current / 1–30 / 31–60 / 61–90 / 90+). Click an invoice to see line items and payment history.</li>
<li><strong>Post payments to the ledger</strong>: maps an income account, a clearing account, and a fee account (one click creates the standard clearing + fee accounts). Each paid payment posts as income through the clearing account with the processing fee expensed. It's idempotent — already-posted payments are skipped, so run it after each weekly import.</li>
<li><strong>Record payment</strong> (on a manual invoice) logs a hand-taken payment; it posts through the same flow.</li>
</ul>

<h3>Ledger</h3>
<p>Every posted transaction. Search payee/memo, filter by date / account / vendor / source, and sort any column. Click a transaction to edit its details; source tags (Manual, CSV, Bank, QuickBooks, Muse) show where each came from.</p>

<h3>Accounts (chart of accounts)</h3>
<ul>
<li>Every account your money flows through, grouped by type. <strong>Add account</strong>, rename, or <strong>Archive</strong> (archived accounts keep their history but leave the pickers).</li>
<li><strong>Import from QuickBooks (.IIF)</strong> in Settings brings a client's existing chart of accounts in; accounts that already exist are skipped, so re-importing is safe.</li>
<li>Click an account to open its <strong>register</strong> — every transaction hitting it with a running balance.</li>
</ul>

<h3>Vendors &amp; rules</h3>
<p>Vendors carry the auto-categorize rules used in Review (exact match wins, then keywords). A rule can target an income/expense account <em>or</em> an account transfer. Click a vendor for a <strong>register</strong> of all its transactions.</p>

<h3>Reconcile</h3>
<p>Tick off transactions against a statement balance for a period and lock it. Reconciled transactions are protected — their amounts, accounts, and status can't be changed afterward.</p>

<h3>Deposits</h3>
<p>Per-day comparison of what was recorded vs. what the processor reported vs. what the bank deposited — surfaces fee/settlement gaps so card deposits reconcile.</p>

<h3>Inventory</h3>
<p>Track items and a shopping list (add ad-hoc supplies or per item; print / email / clear).</p>

<h3>Reports</h3>
<p><strong>Profit &amp; Loss</strong> and <strong>Balance Sheet</strong> for a date range, with compare and drill-downs. <strong>Print / PDF</strong> and <strong>Export CSV</strong> are on the toolbar.</p>

<h3>Settings</h3>
<ul>
<li><strong>Users</strong> and <strong>roles</strong>; device approvals.</li>
<li><strong>Business features</strong>: turn the Invoices and Muse-sync modules on/off per business.</li>
<li><strong>AI</strong> spending: pause AI and set a monthly budget for categorization suggestions.</li>
<li><strong>Muse sync</strong>: map the salon's daily sales/cash types to accounts (when the Muse app pushes daily totals).</li>
<li><strong>QuickBooks</strong>: export the posted ledger as an <code>.IIF</code> file for a date range, and <strong>import a chart of accounts</strong> from QuickBooks.</li>
<li><strong>Close the books</strong>: lock a finished month against changes; reopen anytime.</li>
<li><strong>Rejected writes</strong>: a log of any writes the server turned down (stale or blocked edits) so nothing is silently lost.</li>
</ul>

<h2>Core workflows</h2>
<div class="step"><strong>Weekly bank bookkeeping:</strong> Banking → Import CSV (or Sync now) → Review → categorize / approve (use ⚡ to build rules, % or ⚡$ for deposits with fees) → check Reports.</div>
<div class="step"><strong>Invoice2go A/R:</strong> Invoices → Import the weekly CSV (cutoff date) → Post payments to the ledger → import your bank CSV in Banking → in Review, ⚡$ match the deposits → watch the Invoice2go Clearing account register settle toward $0.</div>
<div class="step"><strong>Month-end:</strong> finish Review → Reconcile each account against its statement and lock → Reports (P&amp;L + Balance Sheet) → Export/Print, or QuickBooks .IIF export.</div>
<div class="step"><strong>New client setup:</strong> create the business → Settings → import their QuickBooks chart of accounts (.IIF) → connect/import bank activity → set vendor rules as you categorize.</div>

<h2>Good to know</h2>
<ul>
<li>Nothing posts to your books automatically — Review/approval is always the gate.</li>
<li>Re-imports are safe: bank rows, Invoice2go invoices/payments, and QB accounts all de-dupe.</li>
<li>Reconciled and locked-period transactions are protected from edits.</li>
<li>Roles limit edits; owners/managers manage users, settings, and integrations.</li>
</ul>
`;

// ── Procedure — the everyday "how do I enter bank + Invoice2go" step-by-step ────
const PROCEDURE = `
<h1>Back Office — How to Enter Bank Transactions &amp; Invoice2go Invoices</h1>
<p class="sub">Your keep-with-you, step-by-step procedure. The one rule that makes this safe: <strong>nothing posts to your books until you Approve it</strong> — you are always in control.</p>

<h2>0 · Sign in</h2>
<ul>
<li>Sign in with your <strong>login name</strong> and <strong>PIN</strong> — this works on <strong>any device or browser</strong>, with no approval step.</li>
<li>For safety the app asks for your PIN again <strong>every time it has been fully closed</strong>, or after <strong>30 minutes idle</strong>. A normal reload won't sign you out.</li>
<li>A <span class="tag" style="background:#d6f0e0;color:#1f7a4d">Synced</span> pill means you're connected; <span class="tag" style="background:#eef0f4;color:#5b5e68">Offline</span> edits catch up automatically once you reconnect.</li>
</ul>

<h2>A · Bank transactions <span class="sub">(do this weekly)</span></h2>
<p><strong>Goal:</strong> get the week's bank activity into the books and put each transaction in the right account.</p>
<h3>Step 1 — Bring the transactions in (use whichever you have set up)</h3>
<div class="step"><strong>Option A — Connected bank feed (automatic):</strong> open the <strong>Banking</strong> tab → click <strong>Sync now</strong>. New transactions flow straight into <strong>Review</strong>. <span class="sub">First-time setup only: <strong>Connect feed</strong> → pick your bank → log in through the secure Plaid screen.</span></div>
<div class="step"><strong>Option B — Import a CSV statement:</strong> on your bank's website download the transactions as a <strong>CSV</strong> → in <strong>Banking</strong> click <strong>Import CSV</strong> → choose the file. It auto-detects the date / description / amount columns and <strong>skips anything already imported</strong>, so overlapping ranges are safe. The new rows land in <strong>Review</strong>.</div>

<h3>Step 2 — Review and approve each transaction</h3>
<p>Open the <strong>Review</strong> tab. Rows are grouped by bank account; each shows a suggested-account chip:</p>
<table>
<tr><th>Chip</th><th>Means</th></tr>
<tr><td><span class="tag" style="background:#dbe7fb;color:#1c4e9c">⚡ Rule</span></td><td>Matched one of your saved vendor rules.</td></tr>
<tr><td><span class="tag" style="background:#d6f0e0;color:#1f7a4d">🕘 You did this before</span></td><td>Matched your own past history.</td></tr>
<tr><td><span class="tag" style="background:#fbeccb;color:#8a5a00">✨ AI</span></td><td>A computer suggestion — always double-check it.</td></tr>
<tr><td><span class="tag" style="background:#eef0f4;color:#5b5e68">No match</span></td><td>You'll pick the account yourself.</td></tr>
</table>
<div class="step"><strong>For each row:</strong> (1) confirm or pick the <strong>Account</strong> the transaction belongs to — the dropdown is type-to-search, and <code>＋ Add account…</code> at the bottom creates a new one without losing your place. (2) Click <strong>Approve</strong>. That posts it to your books.</div>
<p><strong>Speed-ups (toolbar):</strong> <strong>Approve all categorized</strong> posts every row that already has an account (it confirms first, showing the list). <strong>✨ Get AI suggestions</strong> fills in an account for the leftover unmatched rows — you still approve each one.</p>
<p><strong>Per-row buttons worth knowing:</strong></p>
<table>
<tr><th>Button</th><th>Use it when…</th></tr>
<tr><td><strong>⚡</strong> make a rule</td><td>You want this vendor to auto-categorize to the same account next time.</td></tr>
<tr><td><strong>%</strong> deposit with a fee</td><td>A <strong>money-in</strong> deposit had a processing fee taken out — posts the gross income, the fee as an expense, and the net to the bank in one balanced entry.</td></tr>
<tr><td><strong>⚡$</strong> match deposit</td><td>A <strong>money-in</strong> deposit pays off recorded sales/invoices (see Section B, Step 4).</td></tr>
<tr><td><strong>Skip</strong></td><td>Not ready to decide — it moves under "Show skipped," where <strong>Restore</strong> brings it back. Nothing is deleted.</td></tr>
</table>
<p><strong>Transfers between your own accounts</strong> (checking → savings, or paying a credit card) are recognized automatically and never counted as income or expense — pick the "↔ Transfer to / from" account at the top of the dropdown.</p>
<h3>Step 3 — Sanity-check</h3>
<p>Open <strong>Reports → Profit &amp; Loss</strong> for the period to confirm the numbers look right.</p>

<h2>B · Invoice2go invoices <span class="sub">(do this weekly)</span></h2>
<p><strong>Goal:</strong> bring in this week's invoices and customer payments, post the income, and tie the deposit to the bank.</p>
<div class="step"><strong>Step 1 — Export from Invoice2go:</strong> download the weekly invoice list as a <strong>CSV</strong>. You can always export the full list — Back Office de-dupes, so re-importing only adds what's new.</div>
<div class="step"><strong>Step 2 — Import into Back Office:</strong> <strong>Invoices</strong> tab → <strong>Import from Invoice2go</strong> → choose the CSV → set the <strong>cutoff date</strong> (only invoices with a payment on/after that date are imported) → Import. New invoices and payments are added; anything already in is skipped.</div>
<div class="step"><strong>Step 3 — Post the payments to the ledger:</strong> still on <strong>Invoices</strong> → <strong>Post payments to the ledger</strong> → pick an <strong>Income</strong> account, a <strong>Clearing</strong> account, and a <strong>Fee</strong> account (first time only: <strong>Create the standard clearing + fee accounts</strong> makes them in one click) → Post. Each paid payment posts as income through the clearing account, with the fee expensed. Safe to run every week — already-posted payments are skipped.</div>
<div class="step"><strong>Step 4 — Match the bank deposit (ties it all together):</strong> when Invoice2go's money lands in your bank, bring the bank activity in (Section A, Step 1), open <strong>Review</strong>, find the Invoice2go deposit, and click <strong>⚡$ match deposit</strong>. It relieves the <strong>Invoice2go Clearing</strong> account so the income isn't counted twice.</div>
<p><strong>How you know it worked:</strong> open <strong>Accounts</strong> → click <strong>Invoice2go Clearing</strong>. Its balance settles toward <strong>$0.00</strong> as deposits are matched. A leftover balance just means a deposit hasn't been matched yet.</p>

<h2>C · Your weekly rhythm (the short version)</h2>
<table>
<tr><th>#</th><th>Do this</th><th>Where</th></tr>
<tr><td>1</td><td>Import the Invoice2go CSV (set the cutoff date)</td><td>Invoices → Import from Invoice2go</td></tr>
<tr><td>2</td><td>Post payments to the ledger</td><td>Invoices → Post payments to the ledger</td></tr>
<tr><td>3</td><td>Bring in the bank activity</td><td>Banking → Sync now / Import CSV</td></tr>
<tr><td>4</td><td>Approve every row; use <strong>⚡$</strong> to match the deposits</td><td>Review</td></tr>
<tr><td>5</td><td>Check the numbers; confirm Invoice2go Clearing ≈ $0</td><td>Reports → P&amp;L · Accounts</td></tr>
</table>

<h2>D · Month-end (when the month is finished)</h2>
<ol>
<li>Finish <strong>Review</strong> — nothing left waiting.</li>
<li><strong>Reconcile</strong> each bank/credit-card account against its statement: enter the ending balance and tick off the cleared transactions until the <strong>difference is exactly $0.00</strong> (it turns green), then <strong>Close &amp; lock</strong>.</li>
<li><strong>Settings → Close the books</strong> → pick the month → <strong>Close month</strong> (locks it; you can reopen anytime).</li>
<li><strong>Reports</strong> → Profit &amp; Loss and Balance Sheet → <strong>Print / PDF</strong> or <strong>Export CSV</strong>.</li>
</ol>

<h2>Good to know</h2>
<ul>
<li><strong>Nothing posts until you Approve</strong> — Review is always the gate.</li>
<li><strong>Re-imports are safe</strong> — bank rows, Invoice2go invoices/payments, and QuickBooks accounts all de-duplicate.</li>
<li><strong>Reconciled and closed-month transactions are locked</strong> — reopen the period first to change one.</li>
<li>Stuck on a button or a symbol? Tap <strong>your name (top-right) → App guide</strong> for the full button-by-button manual.</li>
</ul>
`;
