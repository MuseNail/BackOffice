// ── view: settings — users, roles, device approvals ────────────────
// Management UI renders only for owner/manager sessions; the server enforces
// the same rule, this is just honest UI. Muse sync + IIF export land M11/M12.
import { el, clear, toast, fmtMoney } from '../ui.js';
import { api, dispatch } from '../sync.js';
import { getActiveBiz, getBusinesses, roleFor } from '../session.js';
import { getState, entities, byId, subscribe } from '../store.js';
import { parseMoney } from '../lib/money.js';

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
  root.append(el('p', { class: 'sub' }, 'Users, roles, device approvals, and AI spending for this business only.'), usersCard, devicesCard, aiCard);
  drawUsers(usersCard, biz);
  drawDevices(devicesCard, biz);
  const drawAI = () => drawAICard(aiCard);
  unsubAI = subscribe(drawAI);
  drawAI();
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
      } }, 'Approve'));
      line.append(el('button', { class: 'btn sm ghost', style: 'margin-left:6px', onclick: async () => {
        const res = await api('/registry/devices/revoke', { method: 'POST', body: JSON.stringify({ businessId: biz, userId: d.userId, deviceId: d.deviceId }) });
        if (res.ok) { toast('Device removed'); drawDevices(card, biz); }
      } }, 'Remove'));
      card.append(line);
    }
  } catch { card.append(el('p', { class: 'sub' }, 'Could not load devices.')); }
}
