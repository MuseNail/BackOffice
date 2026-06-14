// ── view: banking — bank/card accounts, CSV import wizard, import history ────────────────
// Bank accounts are created HERE (not in Accounts): each one is a bankacct
// entity PLUS its linked ledger account (qbType BANK/CCARD), created together.
import { el, clear, toast, modal, fmtMoney } from '../ui.js';
import { entities, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveBiz, canEdit } from '../session.js';
import { startPlaidConnect, syncPlaid } from '../plaid-connect.js';
import { accountBalance } from '../lib/posting.js';
import { parseCsv, detectColumns, normalizeRows, dedupHash } from '../lib/csv.js';

const KINDS = { checking: 'Checking', savings: 'Savings', card: 'Credit card', cash: 'Cash' };

let unsub = null;

export function render(root) {
  const editable = canEdit(getActiveBiz());
  const body = el('div');
  root.append(
    el('h2', {}, 'Banking'),
    el('p', { class: 'sub' }, 'Bank & card accounts, CSV imports, and import history. Imported rows land in Review — nothing posts without your approval.'),
    editable ? el('div', { style: 'margin-bottom:14px' },
      el('button', { class: 'btn sm', onclick: addBankModal }, 'Add bank account')) : null,
    body,
  );
  const draw = () => drawBody(body, editable);
  unsub = subscribe(draw);
  draw();
}

export function unmount() { unsub?.(); unsub = null; }

function drawBody(body, editable) {
  const bankaccts = entities('bankacct');
  const txns = entities('txn');
  const cards = bankaccts.map(b => {
    const bal = accountBalance(txns, b.accountId);
    const pending = entities('staged').filter(s => s.bankacctId === b.id && s.status === 'pending').length;
    return el('div', { class: 'card', style: 'flex:1;min-width:230px' },
      el('div', { class: 'cardtitle' }, b.name),
      el('div', { class: 'sub', style: 'margin:0 0 6px' }, `${KINDS[b.kind] || b.kind}${b.institution ? ' · ' + b.institution : ''}`),
      el('div', { class: 'kpi' }, fmtMoney(bal)),
      pending ? el('span', { class: 'pill amber' }, `${pending} in Review`) : el('span', { class: 'pill green' }, 'Up to date'),
      b.plaid ? el('div', { class: 'sub', style: 'margin:6px 0 0;color:var(--green)' },
        `🔗 ${b.plaid.institution || 'Bank'}${b.plaid.mask ? ' ••' + b.plaid.mask : ''}${b.plaid.lastSyncAt ? ' · synced ' + new Date(b.plaid.lastSyncAt).toLocaleDateString() : ''}`) : null,
      editable ? el('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap' },
        el('button', { class: 'btn sm', onclick: () => importWizard(b) }, 'Import CSV'),
        b.plaid
          ? el('button', { class: 'btn sm', onclick: () => syncPlaid(getActiveBiz()) }, 'Sync now')
          : el('button', { class: 'btn sm', onclick: () => startPlaidConnect(b) }, 'Connect feed')) : el('span'),
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
      ? el('div', { class: 'row', style: 'margin-bottom:16px' }, cards)
      : el('p', { class: 'sub' }, 'No bank accounts yet — add your checking account to start importing.'),
    imports.length ? el('div', { class: 'card', style: 'padding:0;overflow:hidden;max-width:880px' },
      el('table', { class: 'data' },
        el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Account'), el('th', {}, 'File'), el('th', { class: 'num' }, 'Rows'), el('th', { class: 'num' }, 'Dups'), el('th', { class: 'num' }, 'Posted'), el('th', {}, 'Status')),
        ...importRows)) : el('span'),
  );
}

// ── add bank account ──
function addBankModal() {
  const m = modal('Add bank account');
  const name = el('input', { class: 'field-input', placeholder: 'e.g. Chase Checking ··4417' });
  const kind = el('select', { class: 'field-input' }, ...Object.entries(KINDS).map(([v, l]) => el('option', { value: v }, l)));
  const inst = el('input', { class: 'field-input', placeholder: 'optional' });
  m.body.append(
    el('label', { class: 'field-label' }, 'Account name'), name,
    el('label', { class: 'field-label' }, 'Type'), kind,
    el('label', { class: 'field-label' }, 'Bank / institution'), inst,
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
        dispatch({ op: 'entity.upsert', kind: 'bankacct', value: {
          id: 'ba-' + acctId, name: n, institution: inst.value.trim(), kind: kind.value, accountId: acctId, mapping: null,
        } });
        toast('Bank account added');
        m.close();
      } }, 'Add')),
  );
  setTimeout(() => name.focus(), 0);
}

// ── import wizard: upload → map → preview & stage ──
function importWizard(bankacct) {
  const m = modal(`Import — ${bankacct.name}`);
  let parsed = null;   // {headers, rows}
  let filename = '';

  const step1 = () => {
    const file = el('input', { class: 'field-input', type: 'file', accept: '.csv,text/csv' });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      filename = f.name;
      const reader = new FileReader();
      reader.onload = () => {
        parsed = parseCsv(reader.result);
        if (!parsed.rows.length) { toast('That file has no data rows', 'err'); return; }
        step2();
      };
      reader.onerror = () => { toast('Failed to read the file — try again', 'err'); };
      reader.readAsText(f);
    });
    clear(m.body).append(
      el('p', { class: 'sub' }, 'Pick the CSV you downloaded from your bank — any bank’s format works.'),
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

  const step3 = (map, invert) => {
    const { good, bad } = normalizeRows(parsed.rows, map, { invert });
    if (!good.length) { toast('No usable rows with that mapping — check the columns', 'err'); return; }
    const known = new Set(entities('staged').filter(s => s.bankacctId === bankacct.id).map(s => s.dedupHash));
    const fresh = [], dups = [];
    for (const r of good) (known.has(dedupHash(r)) ? dups : fresh).push(r);
    const preview = fresh.slice(0, 8).map(r => el('tr', {},
      el('td', {}, r.date), el('td', {}, r.desc.slice(0, 60)),
      el('td', { class: 'num ' + (r.amountCents < 0 ? 'neg' : 'pos') }, fmtMoney(r.amountCents, { sign: r.amountCents > 0 }))));
    clear(m.body).append(
      el('p', {}, el('b', {}, `${fresh.length} new rows`), ` will go to Review. ${dups.length ? `${dups.length} duplicates skipped (already imported). ` : ''}${bad.length ? `${bad.length} unreadable rows ignored.` : ''}`),
      el('div', { class: 'card', style: 'padding:0;overflow:hidden' },
        el('table', { class: 'data' }, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Description'), el('th', { class: 'num' }, 'Amount')), ...preview)),
      fresh.length > 8 ? el('p', { class: 'sub' }, `…and ${fresh.length - 8} more`) : el('span'),
      el('div', { style: 'display:flex;gap:9px;justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'btn ghost', onclick: step2 }, 'Back'),
        el('button', { class: 'btn green', disabled: !fresh.length, onclick: async () => {
          const importId = 'imp-' + Date.now().toString(36);
          dispatch({ op: 'entity.upsert', kind: 'import', value: {
            id: importId, bankacctId: bankacct.id, filename, importedAt: Date.now(),
            rows: good.length, dups: dups.length, bad: bad.length,
          } });
          // remember this file's mapping (by header name) for next time
          dispatch({ op: 'entity.upsert', kind: 'bankacct', value: { ...bankacct, mapping: {
            dateHeader: parsed.headers[map.date], descHeader: parsed.headers[map.desc],
            amountHeader: map.amount != null ? parsed.headers[map.amount] : null,
            debitHeader: map.debit != null ? parsed.headers[map.debit] : null,
            creditHeader: map.credit != null ? parsed.headers[map.credit] : null,
            invert,
          } } });
          const values = fresh.map((r, i) => ({
            id: `${importId}-r${i}`, importId, bankacctId: bankacct.id,
            date: r.date, desc: r.desc, amountCents: r.amountCents,
            dedupHash: dedupHash(r), status: 'pending',
            source: { app: 'csv', importId },
          }));
          for (let i = 0; i < values.length; i += 400) {
            dispatch({ op: 'entity.bulkUpsert', kind: 'staged', values: values.slice(i, i + 400) });
          }
          toast(`${values.length} rows staged for review`);
          m.close();
          location.hash = `#/b/${getActiveBiz()}/review`;
        } }, `Stage ${fresh.length} rows for review`)),
    );
  };

  step1();
}

const num = (v) => (v === '' || v == null ? null : parseInt(v, 10));
