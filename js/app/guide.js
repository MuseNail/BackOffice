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
h3{font-size:15px;margin:15px 0 3px}
p{margin:6px 0}ul{margin:5px 0 5px 20px;padding:0}li{margin:3px 0}
.sub{color:#666;font-size:13px;margin-top:0}
code{background:#f1f1f1;border-radius:4px;padding:1px 5px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{border:1px solid #dcdcdc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7}
.step{background:#f6faf7;border:1px solid #d7ece0;border-radius:8px;padding:10px 14px;margin:8px 0}
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

// ── Full guide ──
const FULL = `
<h1>Back Office — App Guide</h1>
<p class="sub">Cloud bookkeeping for your businesses. This guide covers every tab, the key buttons, and the workflows they support.</p>

<h2>What Back Office is</h2>
<p>Back Office keeps a full double-entry set of books for one or more businesses. You bring money activity in (bank CSVs, a bank feed, the Invoice2go import, or the Muse salon sync), review and categorize it, and it posts to a ledger that drives your Profit &amp; Loss and Balance Sheet. Nothing posts to your books until you approve it.</p>

<h2>Signing in &amp; switching businesses</h2>
<ul>
<li>Sign in with your name and PIN. Your role (owner / manager / bookkeeper / viewer) controls what you can change.</li>
<li>Owners and multi-business users see <strong>Businesses</strong> to switch between sets of books. Single-business users land straight in their books.</li>
<li>Top-right: your name. Tap it for the <strong>App guide</strong>, <strong>Quick reference</strong>, <strong>What's new</strong>, <strong>Hard reset</strong>, and <strong>Log out</strong>.</li>
<li>The version number is bottom/top of the sidebar; when an update is available it shows a <code>↻</code> — tap to reload to the latest. "Hard reset" in your menu does the same on demand (clears the app cache and reloads; your data is safe).</li>
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
<li>Each row shows a suggested category (from your vendor rules, then your history, then AI). Pick or confirm a category and <strong>Approve</strong>.</li>
<li><strong>⚡</strong> turns a row into an auto-categorize rule for that vendor going forward (income/expense categories <em>and</em> account transfers).</li>
<li><strong>%</strong> records a deposit that had a processing fee taken out (posts gross income, the fee as an expense, and the net to the bank in one balanced entry).</li>
<li><strong>⚡$</strong> matches a deposit to your recorded sales/payments and relieves the clearing account (used for Invoice2go and the salon's card deposits).</li>
<li><strong>Skip</strong> sets a row aside without posting — it moves to "Show skipped," where <strong>Restore</strong> brings it back. Nothing is deleted, and skipped rows still count for de-duplication.</li>
<li>Filter/sort the queue (money in/out, needs-a-category vs ready, by account, newest/largest). <strong>Approve all categorized</strong> posts everything that already has a category. <strong>✨ Get AI suggestions</strong> asks Claude to categorize the unmatched rows (you still approve each).</li>
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
<li>Every category your money flows through, grouped by type. <strong>Add account</strong>, rename, or <strong>Archive</strong> (archived accounts keep their history but leave the pickers).</li>
<li><strong>Import from QuickBooks (.IIF)</strong> in Settings brings a client's existing chart of accounts in; accounts that already exist are skipped, so re-importing is safe.</li>
<li>Click an account to open its <strong>register</strong> — every transaction hitting it with a running balance.</li>
</ul>

<h3>Vendors &amp; rules</h3>
<p>Vendors carry the auto-categorize rules used in Review (exact match wins, then keywords). A rule can target an income/expense category <em>or</em> an account transfer. Click a vendor for a <strong>register</strong> of all its transactions.</p>

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
<li><strong>AI</strong> spending: pause AI and set a monthly budget for categorization suggestions.</li>
<li><strong>Muse sync</strong>: map the salon's daily sales/cash types to accounts (when the Muse app pushes daily totals).</li>
<li><strong>QuickBooks</strong>: export the posted ledger as an <code>.IIF</code> file for a date range, and <strong>import a chart of accounts</strong> from QuickBooks.</li>
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

// ── Quick reference (1–2 pages) ──
const QUICK = `
<h1>Back Office — Quick Reference</h1>
<p class="sub">The everyday essentials on one page.</p>

<h2>Get around</h2>
<ul>
<li><strong>Your name (top-right)</strong> → App guide, Quick reference, What's new, Hard reset, Log out.</li>
<li><strong>Hard reset</strong> reloads the latest version and clears the cache — your data is safe. (The version badge shows <code>↻</code> when an update is waiting.)</li>
<li><strong>Businesses</strong> (owners/multi-business) switches between sets of books.</li>
</ul>

<h2>The weekly routine</h2>
<table>
<tr><th>Goal</th><th>Do this</th></tr>
<tr><td>Bring in bank activity</td><td><strong>Banking</strong> → Import CSV (or Sync now / Connect feed)</td></tr>
<tr><td>Categorize &amp; post it</td><td><strong>Review</strong> → pick a category → <strong>Approve</strong> (or Approve all categorized)</td></tr>
<tr><td>Auto-categorize a vendor</td><td>In Review, <strong>⚡</strong> on the row → set the rule</td></tr>
<tr><td>Deposit with a processing fee</td><td><strong>%</strong> (enter gross) or <strong>⚡$</strong> (match recorded sales)</td></tr>
<tr><td>Set a row aside</td><td><strong>Skip</strong> → later "Show skipped" → Restore</td></tr>
<tr><td>See the numbers</td><td><strong>Reports</strong> → P&amp;L / Balance Sheet → Print or Export CSV</td></tr>
</table>

<h2>Invoices (Invoice2go A/R)</h2>
<ol>
<li><strong>Invoices → Import from Invoice2go</strong> (set the cutoff date). Re-importing weekly is safe.</li>
<li><strong>Post payments to the ledger</strong> (one click creates the clearing + fee accounts; pick your income account).</li>
<li>Import your <strong>bank CSV</strong>, then in <strong>Review</strong> use <strong>⚡$</strong> to match each deposit.</li>
<li>Open the <strong>Invoice2go Clearing</strong> account register — it settles toward $0 as deposits clear.</li>
<li><strong>＋ New invoice</strong> to bill by hand; <strong>Record payment</strong> on it as you get paid.</li>
</ol>

<h2>Month-end</h2>
<ul>
<li>Clear out <strong>Review</strong>.</li>
<li><strong>Reconcile</strong> each account against its statement and lock the period.</li>
<li><strong>Reports</strong> → P&amp;L + Balance Sheet → Export/Print, or QuickBooks <code>.IIF</code> export (Settings).</li>
</ul>

<h2>Remember</h2>
<ul>
<li>Approval is the only way money posts — nothing posts on its own.</li>
<li>Imports de-dupe; reconciled/locked entries are protected.</li>
</ul>
`;
