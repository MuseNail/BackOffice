// ── view: banking — bank/card accounts, CSV import wizard, import history ────────────────
// Bank accounts are created HERE (not in Accounts): each one is a bankacct
// entity PLUS its linked ledger account (qbType BANK/CCARD), created together.
import { el, clear, toast, modal, appendKids, fmtMoney, acctAmount, prettyDesc } from '../ui.js';
import { todayLocal } from '../lib/day.js';
import { entities, subscribe, getStateBiz } from '../store.js';
import { dispatch, api } from '../sync.js';
import { canEdit, roleFor } from '../session.js';
import { startPlaidConnect, syncPlaid, disconnectPlaid, linkExistingAccount } from '../plaid-connect.js';
import { accountBalance } from '../lib/posting.js';
import { plaidErrorText } from '../lib/plaid-feed.js';
import { plaidIntel } from '../lib/plaid-intel.js';
import { parseCsv, detectColumns, normalizeRows, dedupHash } from '../lib/csv.js';
import { looksLikeOfx, parseOfx } from '../lib/ofx.js';
import { parseMoney } from '../lib/money.js';

const KINDS = { checking: 'Checking', savings: 'Savings', card: 'Credit card', cash: 'Cash' };

const STALE_DAYS = 7;

// A broken feed is STATE, not an event. Nothing here polls — no cron, no webhook, no
// sync on load — so unless this line says so, the only way the owner learns a feed died
// is by happening to press Sync. It used to render green "synced <date>" unconditionally,
// which stayed green forever on a dead feed because lastSyncAt was stamped even when the
// pull failed. lastError/lastSyncAt are now only written by a sync that actually worked.
function feedHealth(b) {
  const p = b.plaid || {};
  const label = `${p.institution || 'Bank'}${p.mask ? ' ••' + p.mask : ''}`;
  const sty = (c) => ({ class: 'sub', style: `margin:6px 0 0;color:var(--${c})` });
  if (p.lastError) {
    // Say what THIS failure needs. "Sign in at your bank" is right for exactly one code
    // and wrong for the rest — a partial pull (likely on a first two-year sync) just
    // wants another Sync, and a bank outage wants patience.
    const text = plaidErrorText({ code: p.lastError.code, name: label });
    const partial = p.lastError.code === 'PARTIAL_SYNC';
    return el('div', sty(partial ? 'amber' : 'red'), `⚠️ ${text.charAt(0).toUpperCase()}${text.slice(1)}`);
  }
  if (!p.lastSyncAt) return el('div', sty('mut'), `🔗 ${label} · not synced yet — press Sync now`);
  const days = (Date.now() - p.lastSyncAt) / 86400000;
  const when = new Date(p.lastSyncAt).toLocaleDateString();
  if (days > STALE_DAYS) return el('div', sty('amber'), `🔗 ${label} · last synced ${when} — press Sync now`);
  return el('div', sty('green'), `🔗 ${label} · synced ${when}`);
}

// A recovery strip for an account the bank OFFERS but that isn't linked here. Names the
// offered account (last four) so the owner can eyeball-match it; the actual bind is behind
// linkExistingAccount's identity-confirm. Get full history = a fresh connect (full
// back-history); Just link new = map onto the existing feed (new rows only, no second bill).
function feedOfferStrip(bankacct, candidates) {
  const c = candidates[0];
  const inst = c.institution || bankacct.institution || 'Your bank';
  return el('div', { class: 'feed-offer' },
    el('div', { class: 'feed-offer-title' }, `${inst} is offering an account ••${c.mask}`),
    el('div', { class: 'feed-offer-sub' }, 'Its feed history isn’t in your books yet.'),
    el('div', { class: 'feed-offer-actions' },
      el('button', { class: 'btn sm green', onclick: () => startPlaidConnect(bankacct, { note: 'Getting full history connects this account as a separate bank feed — a small extra cost. To use your existing feed at no extra cost (but without old history), choose “Just link new”.' }) }, 'Get full history'),
      el('button', { class: 'btn sm ghost', onclick: () => linkExistingAccount(bankacct, c) }, 'Just link new')));
}

// Owner/manager only: GET /plaid/accounts is gated to those roles server-side, so anyone
// else would only 403. A failed/403/501 fetch degrades silently — the strips are additive
// over today's cards, never load-bearing.
async function maybeLoadFeedIntel(draw) {
  const biz = getStateBiz();
  if (!['owner', 'manager'].includes(roleFor(biz))) return;
  try {
    const r = await api(`/b/${biz}/plaid/accounts`);
    if (!r.ok) return;
    const data = await r.json().catch(() => ({}));
    plaidItems = Array.isArray(data.items) ? data.items : [];
    draw();
  } catch { /* silent — feed intel is additive over the existing cards */ }
}

let unsub = null;
// Cached GET /plaid/accounts items (owner/manager only; NOT in the synced snapshot).
// Null until the fetch resolves; the per-card feed strips are additive over today's cards.
let plaidItems = null;

export function render(root, detail) {
  const editable = canEdit(getStateBiz());
  plaidItems = null;
  const body = el('div');
  appendKids(root,
    el('h2', {}, 'Banking'),
    el('p', { class: 'sub' }, 'Bank & card accounts, CSV imports, and import history. Imported rows land in Review — nothing posts without your approval.'),
    editable ? el('div', { style: 'margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: addBankModal }, 'Add bank account')) : null,
    body,
  );
  const draw = () => drawBody(body, editable);
  unsub = subscribe(draw);
  draw();
  maybeLoadFeedIntel(draw);
  // "+ New" deep-links: /banking/new opens add-account; /banking/import opens the CSV
  // wizard when there's a single account (otherwise the per-account Import buttons show).
  if (editable && detail === 'new') addBankModal();
  else if (editable && detail === 'import') { const a = entities('bankacct'); if (a.length === 1) importWizard(a[0]); }
}

export function unmount() { unsub?.(); unsub = null; }

function drawBody(body, editable) {
  const bankaccts = entities('bankacct');
  const txns = entities('txn');
  const intel = plaidIntel(bankaccts, plaidItems || []);
  const cards = bankaccts.map(b => {
    const bal = accountBalance(txns, b.accountId);
    const pending = entities('staged').filter(s => s.bankacctId === b.id && s.status === 'pending').length;
    const opening = txns.find(t => t.id === 't-opening-' + b.id);
    const openLine = opening?.lines.find(l => l.accountId === b.accountId);
    return el('div', { class: 'card', style: 'display:flex;flex-direction:column;margin:0' },
      el('div', { class: 'cardtitle' }, b.name),
      el('div', { class: 'sub', style: 'margin:0 0 6px' }, `${KINDS[b.kind] || b.kind}${b.institution ? ' · ' + b.institution : ''}`),
      el('a', { class: 'kpi', href: `#/b/${getStateBiz()}/ledger/${b.accountId}`, title: 'Open this account’s register in the Ledger', style: 'display:block;text-decoration:none;color:inherit' }, fmtMoney(bal)),
      pending ? el('span', { class: 'pill amber' }, `${pending} in Review`) : el('span', { class: 'pill green' }, 'Up to date'),
      openLine ? el('div', { class: 'sub', style: 'margin:6px 0 0' }, `Opening ${fmtMoney(openLine.amountCents)} as of ${opening.date}`) : null,
      b.plaid ? feedHealth(b) : null,
      (editable && intel[b.id] && intel[b.id].status === 'offered') ? feedOfferStrip(b, intel[b.id].candidates) : null,
      editable ? el('div', { style: 'margin-top:auto;padding-top:10px;display:flex;gap:6px;flex-wrap:wrap' },
        el('button', { class: 'btn sm', onclick: () => importWizard(b) }, 'Import CSV'),
        el('button', { class: 'btn sm ghost', onclick: () => openingBalanceModal(b) }, openLine ? 'Opening balance' : 'Set opening balance'),
        b.plaid
          ? el('button', { class: 'btn sm', onclick: () => syncPlaid(getStateBiz()) }, 'Sync now')
          : el('button', { class: 'btn sm', onclick: () => startPlaidConnect(b) }, 'Connect feed'),
        b.plaid ? el('button', { class: 'btn sm ghost', onclick: () => disconnectPlaid(b) }, 'Disconnect') : null) : el('span'),
    );
  });

  const imports = entities('import').sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0)).slice(0, 20);
  const staged = entities('staged');
  const importRows = imports.map(im => {
    const mine = staged.filter(s => s.importId === im.id);
    const pending = mine.filter(s => s.status === 'pending').length;
    const posted = mine.filter(s => s.status === 'approved').length;
    return el('tr', {},
      el('td', {}, new Date(im.importedAt).toLocaleDateString()),
      el('td', {}, entities('bankacct').find(b => b.id === im.bankacctId)?.name || im.bankacctId),
      el('td', {}, im.filename),
      el('td', { class: 'num' }, String(im.rows)),
      el('td', { class: 'num' }, String(im.dups)),
      el('td', { class: 'num' }, String(posted)),
      el('td', {}, pending
        ? el('span', { class: 'pill amber' }, `${pending} in Review`)
        : el('span', { class: 'pill green' }, 'Done')),
    );
  });

  clear(body).append(
    bankaccts.length
      ? el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:14px;align-items:stretch;margin-bottom:18px' }, cards)
      : el('p', { class: 'sub' }, 'No bank accounts yet — add your checking account to start importing.'),
    imports.length ? el('div', { style: 'max-width:880px' },
      el('div', { class: 'cardtitle', style: 'margin-bottom:6px' }, 'Import history'),
      el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin:0' },
        el('table', { class: 'data xl' },
          el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Account'), el('th', {}, 'File'), el('th', { class: 'num' }, 'Rows'), el('th', { class: 'num' }, 'Dups'), el('th', { class: 'num' }, 'Posted'), el('th', {}, 'Status'))),
          el('tbody', {}, ...importRows)))) : el('span'),
  );
}

// ── add bank account ──
function addBankModal() {
  const m = modal('Add bank account');
  const name = el('input', { class: 'field-input', placeholder: 'e.g. Chase Checking ··4417' });
  const kind = el('select', { class: 'field-input' }, ...Object.entries(KINDS).map(([v, l]) => el('option', { value: v }, l)));
  const inst = el('input', { class: 'field-input', placeholder: 'optional' });
  const openAmt = el('input', { class: 'field-input', inputmode: 'decimal', placeholder: 'optional — current balance' });
  const openDate = el('input', { class: 'field-input', type: 'date', value: todayLocal() });
  m.body.append(
    el('label', { class: 'field-label' }, 'Account name'), name,
    el('label', { class: 'field-label' }, 'Type'), kind,
    el('label', { class: 'field-label' }, 'Bank / institution'), inst,
    el('label', { class: 'field-label' }, 'Opening balance (optional)'), openAmt,
    el('label', { class: 'field-label' }, 'Opening balance as of'), openDate,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const n = name.value.trim();
        if (!n) { toast('Name the account', 'err'); return; }
        const isCard = kind.value === 'card';
        const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'bank';
        const taken = new Set(entities('account').map(a => a.id));
        let acctId = slug, i = 2;
        while (taken.has(acctId)) acctId = `${slug}-${i++}`;
        dispatch({ op: 'entity.upsert', kind: 'account', value: {
          id: acctId, name: n, type: isCard ? 'liability' : 'asset',
          qbType: isCard ? 'CCARD' : 'BANK', qbName: n, active: true,
        } });
        const ba = { id: 'ba-' + acctId, name: n, institution: inst.value.trim(), kind: kind.value, accountId: acctId, mapping: null };
        dispatch({ op: 'entity.upsert', kind: 'bankacct', value: ba });
        const oc = parseMoney(openAmt.value);
        if (oc) setOpeningBalance(ba, oc, openDate.value);
        toast('Bank account added');
        m.close();
      } }, 'Add')),
  );
  setTimeout(() => name.focus(), 0);
}

// ── opening balance ──
// Posts a balanced opening entry (deterministic id t-opening-<bankacctId>) so the
// account's balance reflects its real starting point. Debit the bank's account /
// credit Opening Balance Equity (auto-created). Liability accounts (cards) negate,
// so an entered "amount owed" increases the liability like a charge does. Re-setting
// updates the same entry; a zero/blank amount removes it.
function ensureOpeningEquity() {
  const id = 'opening-balance-equity';
  if (!entities('account').find(a => a.id === id)) {
    dispatch({ op: 'entity.upsert', kind: 'account', value: { id, name: 'Opening Balance Equity', type: 'equity', qbType: 'EQUITY', qbName: 'Opening Balance Equity', active: true } });
  }
  return id;
}
function setOpeningBalance(bankacct, cents, asOfDate) {
  const id = 't-opening-' + bankacct.id;
  if (!cents) { if (entities('txn').find(t => t.id === id)) dispatch({ op: 'entity.delete', kind: 'txn', id }); return; }
  const acct = entities('account').find(a => a.id === bankacct.accountId);
  const lineCents = acct?.type === 'liability' ? -cents : cents;
  const eqId = ensureOpeningEquity();
  dispatch({ op: 'entity.upsert', kind: 'txn', value: {
    id, date: asOfDate, payee: 'Opening balance', memo: 'Opening balance — ' + bankacct.name,
    lines: [{ accountId: bankacct.accountId, amountCents: lineCents }, { accountId: eqId, amountCents: -lineCents }],
    status: 'posted', source: { app: 'manual', sourceId: 'opening' },
  } });
}
function openingBalanceModal(bankacct) {
  const ex = entities('txn').find(t => t.id === 't-opening-' + bankacct.id);
  const acct = entities('account').find(a => a.id === bankacct.accountId);
  const isLia = acct?.type === 'liability';
  const exLine = ex?.lines.find(l => l.accountId === bankacct.accountId);
  const exVal = exLine ? ((isLia ? -exLine.amountCents : exLine.amountCents) / 100).toFixed(2) : '';
  const m = modal('Opening balance — ' + bankacct.name);
  const amt = el('input', { class: 'field-input', inputmode: 'decimal', value: exVal, placeholder: '0.00' });
  const date = el('input', { class: 'field-input', type: 'date', value: ex?.date || todayLocal() });
  m.body.append(
    el('p', { class: 'sub' }, `Set this account's starting balance ${isLia ? '(amount owed) ' : ''}as of a date. It posts a balanced entry to Opening Balance Equity so the displayed balance matches your statement.`),
    el('label', { class: 'field-label' }, isLia ? 'Balance owed' : 'Current balance'), amt,
    el('label', { class: 'field-label' }, 'As of'), date,
    el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
      ex ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--red)', onclick: () => { setOpeningBalance(bankacct, 0); toast('Opening balance removed'); m.close(); } }, 'Remove') : null,
      el('button', { class: 'btn ghost', onclick: m.close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => {
        const cents = parseMoney(amt.value);
        if (cents == null) { toast('Enter an amount like 1000.00', 'err'); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { toast('Pick a date', 'err'); return; }
        setOpeningBalance(bankacct, cents, date.value);
        toast('Opening balance set');
        m.close();
      } }, 'Save')),
  );
  setTimeout(() => amt.focus(), 0);
}

// ── import wizard: upload → map → preview & stage ──
function importWizard(bankacct) {
  const m = modal(`Import — ${bankacct.name}`);
  let parsed = null;   // {headers, rows} — CSV path only
  let filename = '';

  const step1 = () => {
    const file = el('input', { class: 'field-input', type: 'file', accept: '.csv,.qfx,.qbo,.ofx,text/csv' });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      filename = f.name;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        // QFX/QBO/OFX carry structured transactions (with a unique FITID) — no column
        // mapping needed, so go straight to the preview. Otherwise treat it as CSV.
        if (looksLikeOfx(text)) {
          const { rows } = parseOfx(text);
          if (!rows.length) { toast('No transactions found in that QFX/QBO/OFX file', 'err'); return; }
          stagePreview(rows, 0, { back: step1 });
          return;
        }
        parsed = parseCsv(text);
        if (!parsed.rows.length) { toast('That file has no data rows', 'err'); return; }
        step2();
      };
      reader.onerror = () => { toast('Failed to read the file — try again', 'err'); };
      reader.readAsText(f);
    });
    clear(m.body).append(
      el('p', { class: 'sub' }, 'Pick the file you downloaded from your bank — a CSV (any bank’s format) or a QFX / QBO / OFX file. QFX & QBO carry a unique id per transaction, so duplicates can never slip in.'),
      file,
    );
  };

  const step2 = () => {
    const det = detectColumns(parsed.headers, parsed.rows);
    const saved = bankacct.mapping;
    const byHeader = (h) => { const i = parsed.headers.indexOf(h); return i === -1 ? null : i; };
    const pre = {
      date: saved?.dateHeader != null ? byHeader(saved.dateHeader) ?? det.date : det.date,
      desc: saved?.descHeader != null ? byHeader(saved.descHeader) ?? det.desc : det.desc,
      amount: saved?.amountHeader != null ? byHeader(saved.amountHeader) ?? det.amount : det.amount,
      debit: saved?.debitHeader != null ? byHeader(saved.debitHeader) ?? det.debit : det.debit,
      credit: saved?.creditHeader != null ? byHeader(saved.creditHeader) ?? det.credit : det.credit,
    };
    const colSel = (idx) => el('select', { class: 'field-input' },
      el('option', { value: '' }, '— column —'),
      ...parsed.headers.map((h, i) => el('option', { value: String(i), selected: i === idx }, h || `(column ${i + 1})`)));
    const mode = el('select', { class: 'field-input' },
      el('option', { value: 'single', selected: pre.amount != null || pre.debit == null }, 'One amount column (− is money out)'),
      el('option', { value: 'pair', selected: pre.amount == null && pre.debit != null }, 'Separate debit / credit columns'));
    const date = colSel(pre.date), desc = colSel(pre.desc), amount = colSel(pre.amount), debit = colSel(pre.debit), credit = colSel(pre.credit);
    const invert = el('input', { type: 'checkbox' });
    if (saved?.invert) invert.checked = true;
    const pairBox = el('div', { class: 'f2', style: pre.amount != null || pre.debit == null ? 'display:none' : '' },
      el('div', {}, el('label', { class: 'field-label' }, 'Money out (debit)'), debit),
      el('div', {}, el('label', { class: 'field-label' }, 'Money in (credit)'), credit));
    const singleBox = el('div', { style: pre.amount == null && pre.debit != null ? 'display:none' : '' },
      el('label', { class: 'field-label' }, 'Amount'), amount);
    mode.addEventListener('change', () => {
      singleBox.style.display = mode.value === 'single' ? '' : 'none';
      pairBox.style.display = mode.value === 'pair' ? '' : 'none';
    });
    clear(m.body).append(
      el('p', { class: 'sub' }, `${parsed.rows.length} rows in ${filename}. Columns were detected automatically — fix any that look wrong.`),
      el('div', { class: 'f2' },
        el('div', {}, el('label', { class: 'field-label' }, 'Date'), date),
        el('div', {}, el('label', { class: 'field-label' }, 'Description'), desc)),
      el('label', { class: 'field-label' }, 'Amounts'), mode,
      singleBox, pairBox,
      el('label', { style: 'display:flex;align-items:center;gap:8px;margin:10px 0;font-weight:600' }, invert, ' Flip signs (some card statements list charges as positive)'),
      el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'btn ghost', onclick: step1 }, 'Back'),
        el('button', { class: 'btn', onclick: () => {
          const map = {
            date: num(date.value), desc: num(desc.value),
            amount: mode.value === 'single' ? num(amount.value) : null,
            debit: mode.value === 'pair' ? num(debit.value) : null,
            credit: mode.value === 'pair' ? num(credit.value) : null,
          };
          if (map.date == null || map.desc == null || (map.amount == null && map.debit == null)) { toast('Pick the date, description, and amount columns', 'err'); return; }
          step3(map, invert.checked);
        } }, 'Preview')),
    );
  };

  // A row's stored identity. OFX/QFX/QBO rows key on the bank's unique FITID
  // (bulletproof); CSV rows fall back to date+amount+description.
  const dedupHashFor = (r) => (r.fitid ? `ofx:${r.fitid}` : dedupHash(r));

  // Shared preview + stage step for both the CSV and the OFX/QFX/QBO paths.
  // good = normalized rows [{date, desc, amountCents, fitid?}]; onStage runs just
  // before staging (the CSV path uses it to remember its column mapping).
  const stagePreview = (good, bad, { back, onStage } = {}) => {
    if (!good.length) { toast('No usable rows in that file', 'err'); return; }
    const stored = entities('staged').filter(s => s.bankacctId === bankacct.id);
    // Match on either the stored identity (FITID for OFX, plain for CSV) or a
    // recomputed plain hash — so a re-import dedupes even across the two formats.
    const knownPrimary = new Set(stored.map(s => s.dedupHash));
    const knownPlain = new Set(stored.map(s => dedupHash(s)));
    const fresh = [], dups = [];
    for (const r of good) ((knownPrimary.has(dedupHashFor(r)) || knownPlain.has(dedupHash(r))) ? dups : fresh).push(r);
    const preview = fresh.slice(0, 8).map(r => el('tr', {},
      el('td', {}, r.date), el('td', {}, prettyDesc(r.desc).slice(0, 60)),
      el('td', { class: 'num' }, acctAmount(r.amountCents, { colored: true, sign: r.amountCents > 0 }))));
    clear(m.body).append(
      el('p', {}, el('b', {}, `${fresh.length} new rows`), ` will go to Review. ${dups.length ? `${dups.length} duplicates skipped (already imported). ` : ''}${bad ? `${bad} unreadable rows ignored.` : ''}`),
      el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
        el('table', { class: 'data xl' }, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Description'), el('th', { class: 'num' }, 'Amount'))), el('tbody', {}, ...preview))),
      fresh.length > 8 ? el('p', { class: 'sub' }, `…and ${fresh.length - 8} more`) : el('span'),
      el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'btn ghost', onclick: back || step1 }, 'Back'),
        el('button', { class: 'btn green', disabled: !fresh.length, onclick: async () => {
          const importId = 'imp-' + Date.now().toString(36);
          dispatch({ op: 'entity.upsert', kind: 'import', value: {
            id: importId, bankacctId: bankacct.id, filename, importedAt: Date.now(),
            rows: good.length, dups: dups.length, bad,
          } });
          onStage?.();
          const values = fresh.map((r, i) => ({
            id: `${importId}-r${i}`, importId, bankacctId: bankacct.id,
            date: r.date, desc: r.desc, amountCents: r.amountCents,
            dedupHash: dedupHashFor(r), status: 'pending',
            source: { app: r.fitid ? 'ofx' : 'csv', importId },
          }));
          for (let i = 0; i < values.length; i += 400) {
            dispatch({ op: 'entity.bulkUpsert', kind: 'staged', values: values.slice(i, i + 400) });
          }
          toast(`${values.length} rows staged for review`);
          m.close();
          location.hash = `#/b/${getStateBiz()}/review`;
        } }, `Stage ${fresh.length} rows for review`)),
    );
  };

  const step3 = (map, invert) => {
    const { good, bad } = normalizeRows(parsed.rows, map, { invert });
    if (!good.length) { toast('No usable rows with that mapping — check the columns', 'err'); return; }
    stagePreview(good, bad.length, { back: step2, onStage: () => {
      // remember this file's mapping (by header name) for next time
      dispatch({ op: 'entity.upsert', kind: 'bankacct', value: { ...bankacct, mapping: {
        dateHeader: parsed.headers[map.date], descHeader: parsed.headers[map.desc],
        amountHeader: map.amount != null ? parsed.headers[map.amount] : null,
        debitHeader: map.debit != null ? parsed.headers[map.debit] : null,
        creditHeader: map.credit != null ? parsed.headers[map.credit] : null,
        invert,
      } } });
    } });
  };

  step1();
}

const num = (v) => (v === '' || v == null ? null : parseInt(v, 10));
