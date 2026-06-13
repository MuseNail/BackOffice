// ── view: settings — users, roles, device approvals ────────────────
// Management UI renders only for owner/manager sessions; the server enforces
// the same rule, this is just honest UI. Muse sync + IIF export land M11/M12.
import { el, clear, toast, fmtMoney } from '../ui.js';
import { api, dispatch } from '../sync.js';
import { getActiveBiz, getBusinesses, roleFor } from '../session.js';
import { getState, entities, byId, subscribe } from '../store.js';
import { parseMoney } from '../lib/money.js';
import { MUSE_SYNC_TYPES } from '../lib/musesync.js';
import { accountLabel } from '../lib/coa-templates.js';
import { buildIif } from '../lib/qb-iif.js';
import { ORIGIN } from '../config.js';

const ROLES = ['owner', 'manager', 'bookkeeper', 'viewer'];
const ROLE_HELP = { owner: 'everything', manager: 'everything but deleting the business', bookkeeper: 'edit the books', viewer: 'read-only' };

export function render(root) {
  const biz = getActiveBiz();
  const myRole = roleFor(biz);
  const bizName = getState().meta?.name || getBusinesses().find(b => b.id === biz)?.name || biz;
  root.append(el('h2', {}, `Settings — ${bizName}`));
  if (!['owner', 'manager'].includes(myRole)) {
    root.append(el('p', { class: 'sub' }, 'Users and devices are managed by the owner.'));
    return;
  }
  const usersCard = el('div', { class: 'card', style: 'max-width:560px' });
  const devicesCard = el('div', { class: 'card', style: 'max-width:560px' });
  const aiCard = el('div', { class: 'card', style: 'max-width:560px' });
  const museCard = el('div', { class: 'card', style: 'max-width:640px' });
  const qbCard = el('div', { class: 'card', style: 'max-width:560px' });
  root.append(el('p', { class: 'sub' }, 'Users, roles, device approvals, AI spending, the Muse salon sync, and the QuickBooks export for this business only.'), usersCard, devicesCard, aiCard, museCard, qbCard);
  drawUsers(usersCard, biz);
  drawDevices(devicesCard, biz);
  const drawAI = () => drawAICard(aiCard);
  const drawMuse = () => drawMuseCard(museCard, biz);
  const drawQb = () => drawQbCard(qbCard, biz);
  unsubAI = subscribe(() => { drawAI(); drawMuse(); drawQb(); });
  drawAI();
  drawMuse();
  drawQb();
}

let unsubAI = null;
export function unmount() { unsubAI?.(); unsubAI = null; }

// ── AI usage & controls ──
function drawAICard(card) {
  const month = new Date().toISOString().slice(0, 7);
  const usage = entities('aiusage');
  const monthRows = usage.filter(u => u.month === month);
  const monthMicros = monthRows.reduce((s, u) => s + (u.costMicros || 0), 0);
  const lifetimeMicros = usage.reduce((s, u) => s + (u.costMicros || 0), 0);
  const settings = byId('aisetting', 'ai') || { id: 'ai', monthlyBudgetCents: 0, paused: false };
  const budgetMicros = (settings.monthlyBudgetCents || 0) * 10000;

  const fmtMicros = (m) => '$' + (m / 1e6).toFixed(2);
  const budget = el('input', { class: 'field-input', style: 'max-width:140px;margin:0', placeholder: 'no cap', inputmode: 'decimal',
    value: settings.monthlyBudgetCents ? (settings.monthlyBudgetCents / 100).toFixed(2) : '' });
  const paused = el('input', { type: 'checkbox', checked: !!settings.paused });

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'AI usage & spending'),
    el('p', { class: 'sub' }, 'Every Claude call this business makes is metered here. The budget and pause switch are enforced on the server before any money is spent — the hard backstop is still the spend limit in your Anthropic Console.'),
    el('table', { class: 'data' },
      el('tr', {}, el('td', {}, 'This month'), el('td', { class: 'num' }, el('b', {}, fmtMicros(monthMicros))),
        el('td', { style: 'color:var(--mut)' }, `${monthRows.length} batch${monthRows.length === 1 ? '' : 'es'}${budgetMicros ? ` · budget ${fmtMicros(budgetMicros)}` : ''}`)),
      el('tr', {}, el('td', {}, 'All time'), el('td', { class: 'num' }, fmtMicros(lifetimeMicros)),
        el('td', { style: 'color:var(--mut)' }, `${usage.length} batch${usage.length === 1 ? '' : 'es'}`)),
    ),
    budgetMicros && monthMicros >= budgetMicros ? el('p', {}, el('span', { class: 'pill red' }, 'Monthly budget reached — AI is blocked until next month or a higher cap')) : el('span'),
    settings.paused ? el('p', {}, el('span', { class: 'pill amber' }, 'AI is paused')) : el('span'),
    el('div', { style: 'display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-top:10px' },
      el('div', {}, el('label', { class: 'field-label' }, 'Monthly budget ($, blank = no cap)'), budget),
      el('label', { style: 'display:flex;align-items:center;gap:8px;font-weight:600;padding-bottom:9px' }, paused, ' Pause AI suggestions'),
      el('button', { class: 'btn sm', onclick: () => {
        const cents = budget.value.trim() === '' ? 0 : parseMoney(budget.value);
        if (cents === null || cents < 0) { toast('Budget should look like 5.00', 'err'); return; }
        dispatch({ op: 'entity.upsert', kind: 'aisetting', value: { ...settings, monthlyBudgetCents: cents, paused: paused.checked } });
        toast('AI settings saved');
      } }, 'Save')),
  );
}

// ── Muse sync mapping (M11) ──
// Where each synced salon row posts: the BALANCING side is fixed here per row
// type; the suggested CATEGORY is just the Review screen's preselect. Stored on
// meta.museMapping so it syncs to every device of this business.
function drawMuseCard(card, biz) {
  const meta = getState().meta || {};
  const mapping = meta.museMapping || { balancing: {}, category: {} };
  const accounts = entities('account').filter(a => a.active !== false);
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const acctSelect = (selected, hint) => el('select', { class: 'field-input', style: 'margin:0;min-width:180px' },
    el('option', { value: '' }, hint ? `— e.g. ${hint} —` : '—'),
    ...accounts
      .slice()
      .sort((a, b) => (a.type + accountLabel(a, accountsById)).localeCompare(b.type + accountLabel(b, accountsById)))
      .map(a => el('option', { value: a.id, selected: a.id === selected }, `${accountLabel(a, accountsById)} (${a.type})`)));

  const rows = [];
  const sels = {};
  for (const [type, t] of Object.entries(MUSE_SYNC_TYPES)) {
    const bal = acctSelect(mapping.balancing?.[type], t.balHint);
    const cat = acctSelect(mapping.category?.[type], t.catHint);
    sels[type] = { bal, cat };
    rows.push(el('tr', {},
      el('td', {}, el('b', {}, t.label), el('div', { class: 'sub', style: 'margin:0' }, t.dir === 'in' ? 'money in' : 'money out')),
      el('td', {}, bal), el('td', {}, cat)));
  }

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'Muse sync — salon → books'),
    el('p', { class: 'sub' },
      'The salon app pushes its finalized daily numbers here; they wait on the Review screen and post only when you approve them. ',
      'Set where each row type lands: the balancing account is the other side of the entry, the category is what Review pre-picks. ',
      `Muse pushes to ${ORIGIN}/sync/inbound for business “${biz}” using the SYNC_TOKEN secret (set on this Worker and in Muse's Back Office sync card).`),
    el('table', { class: 'data' },
      el('tr', {}, el('th', {}, 'Salon row'), el('th', {}, 'Balancing account'), el('th', {}, 'Suggested category')),
      ...rows),
    el('div', { style: 'margin-top:10px' },
      el('button', { class: 'btn sm', onclick: () => {
        const balancing = {}, category = {};
        for (const [type, s] of Object.entries(sels)) {
          if (s.bal.value) balancing[type] = s.bal.value;
          if (s.cat.value) category[type] = s.cat.value;
        }
        dispatch({ op: 'meta.set', value: { ...getState().meta, museMapping: { balancing, category } } });
        toast('Muse mapping saved');
      } }, 'Save mapping')),
  );
}

// ── QuickBooks Desktop export (M12) ──
// Writes an .iif of every POSTED txn in the range plus the full chart of
// accounts (QB auto-creates any account it's missing). Exported txns are
// stamped qbExportedAt so a later overlapping export warns — QB will happily
// import the same journal entries twice and double the books.
function drawQbCard(card, biz) {
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const today = new Date().toISOString().slice(0, 10);
  const from = el('input', { class: 'field-input', type: 'date', style: 'margin:0;max-width:170px', value: monthStart });
  const to = el('input', { class: 'field-input', type: 'date', style: 'margin:0;max-width:170px', value: today });
  const result = el('p', { class: 'sub', style: 'margin-top:8px' });

  const doExport = () => {
    if (!from.value || !to.value || from.value > to.value) { toast('Pick a valid date range', 'err'); return; }
    const accounts = entities('account');
    const { text, count, txns } = buildIif({ accounts: accounts.filter(a => a.active !== false), txns: entities('txn'), from: from.value, to: to.value });
    if (!count) { toast('No posted transactions in that range', 'err'); return; }
    const already = txns.filter(t => t.qbExportedAt).length;
    if (already && !confirm(`${already} of these ${count} transactions were exported before — importing them into QuickBooks again will double them there. Export anyway?`)) return;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `backoffice-${biz}-${from.value}-to-${to.value}.iif`;
    a.click();
    URL.revokeObjectURL(a.href);

    const now = Date.now();
    const stamped = txns.map(t => ({ ...t, qbExportedAt: now, updatedAt: now }));
    for (let i = 0; i < stamped.length; i += 400) {
      dispatch({ op: 'entity.bulkUpsert', kind: 'txn', values: stamped.slice(i, i + 400) });
    }
    result.textContent = `Exported ${count} transactions (${already} re-exports). In QuickBooks Desktop: File → Utilities → Import → IIF Files.`;
    toast(`Exported ${count} transactions to .iif`);
  };

  clear(card).append(
    el('div', { class: 'cardtitle' }, 'QuickBooks Desktop export'),
    el('p', { class: 'sub' }, 'Download an .iif file of the posted ledger for a date range, including the chart of accounts. Already-exported transactions trigger a duplicate warning.'),
    el('div', { style: 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap' },
      el('div', {}, el('label', { class: 'field-label' }, 'From'), from),
      el('div', {}, el('label', { class: 'field-label' }, 'To'), to),
      el('button', { class: 'btn sm', onclick: doExport }, 'Export .iif')),
    result,
  );
}

async function drawUsers(card, biz) {
  clear(card).append(el('div', { class: 'cardtitle' }, 'Users'));
  try {
    const { users } = await (await api(`/registry/users?businessId=${biz}`)).json();
    const rows = users.map(u => el('div', { class: 'rowline' },
      el('b', {}, u.name), el('span', { class: 'sub', style: 'margin:0' }, ` ${u.identifier} · ${u.role}`)));
    card.append(...(rows.length ? rows : [el('p', { class: 'sub' }, 'No client users yet — the owner account always has access.')]));
  } catch { card.append(el('p', { class: 'sub' }, 'Could not load users.')); }

  const name = el('input', { class: 'field-input', placeholder: 'Name' });
  const ident = el('input', { class: 'field-input', placeholder: 'Login name' });
  const pin = el('input', { class: 'field-input', placeholder: 'PIN (4–8 digits)', inputmode: 'numeric' });
  const role = el('select', { class: 'field-input' }, ...ROLES.map(r => el('option', { value: r, selected: r === 'bookkeeper' }, `${r} — ${ROLE_HELP[r]}`)));
  card.append(el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const res = await api('/registry/users', {
      method: 'POST',
      body: JSON.stringify({ businessId: biz, name: name.value.trim(), identifier: ident.value, pin: pin.value, role: role.value }),
    });
    if (res.ok) { toast('User added'); drawUsers(card, biz); }
    else toast((await res.json()).error === 'identifier taken' ? 'That login name is taken' : 'Check the fields', 'err');
  } },
    el('div', { class: 'cardtitle', style: 'margin-top:14px' }, 'Add user'),
    name, ident, pin, role,
    el('button', { class: 'btn', type: 'submit' }, 'Add user'),
  ));
}

async function drawDevices(card, biz) {
  clear(card).append(el('div', { class: 'cardtitle' }, 'Devices'));
  try {
    const { devices } = await (await api(`/registry/devices?businessId=${biz}`)).json();
    if (!devices.length) card.append(el('p', { class: 'sub' }, 'No user devices yet.'));
    for (const d of devices) {
      const line = el('div', { class: 'rowline' },
        el('b', {}, d.userName), el('span', { class: 'sub', style: 'margin:0' }, ` ${d.name || d.deviceId} · ${d.status}`));
      if (d.status === 'pending') line.append(el('button', { class: 'btn sm', style: 'margin-left:10px', onclick: async () => {
        const res = await api('/registry/devices/approve', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: d.userId, deviceId: d.deviceId }) });
        if (res.ok) { toast('Device approved'); drawDevices(card, biz); }
        else toast('Could not approve device — check your role or reload', 'err');
      } }, 'Approve'));
      line.append(el('button', { class: 'btn sm ghost', style: 'margin-left:6px', onclick: async () => {
        const res = await api('/registry/devices/revoke', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: d.userId, deviceId: d.deviceId }) });
        if (res.ok) { toast('Device removed'); drawDevices(card, biz); }
        else toast('Could not remove device — check your role or reload', 'err');
      } }, 'Remove'));
      card.append(line);
    }
  } catch { card.append(el('p', { class: 'sub' }, 'Could not load devices.')); }
}
