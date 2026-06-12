// ── view: settings — users, roles, device approvals ────────────────
// Management UI renders only for owner/manager sessions; the server enforces
// the same rule, this is just honest UI. Muse sync + IIF export land M11/M12.
import { el, clear, toast } from '../ui.js';
import { api } from '../sync.js';
import { getActiveBiz, getBusinesses, roleFor } from '../session.js';
import { getState } from '../store.js';

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
  root.append(el('p', { class: 'sub' }, 'Users, roles, and device approvals for this business only.'), usersCard, devicesCard);
  drawUsers(usersCard, biz);
  drawDevices(devicesCard, biz);
}

export function unmount() {}

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
