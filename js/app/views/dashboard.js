// ── view: dashboard ────────────────
import { el } from '../ui.js';
import { getState, subscribe, entities } from '../store.js';
import { getActiveBiz } from '../session.js';
import { industryLabel } from '../lib/coa-templates.js';

let unsub = null;

export function render(root) {
  const body = el('div');
  const draw = () => {
    const s = getState();
    const accounts = entities('account').filter(a => a.active !== false);
    body.replaceChildren(
      el('h2', {}, s.meta?.name || getActiveBiz()),
      el('p', { class: 'sub' }, s.meta
        ? `${industryLabel(s.meta.industry)} · fiscal year starts ${s.meta.fiscalYearStart || 'January'}`
        : 'Business profile not set up yet.'),
      el('div', { class: 'card' },
        el('div', { class: 'cardtitle' }, 'Chart of accounts'),
        el('p', {}, accounts.length
          ? `${accounts.length} active accounts — the full Accounts screen arrives with M3.`
          : 'No accounts yet.')),
      el('div', { class: 'card' },
        el('div', { class: 'cardtitle' }, 'Connected'),
        el('p', {}, `Synced through mutation #${s.seq}. Cash position, review counts, and activity arrive with the ledger (M4+).`)),
    );
  };
  unsub = subscribe(draw);
  draw();
  root.append(body);
}

export function unmount() { unsub?.(); unsub = null; }
