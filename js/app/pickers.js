// ── Inline "＋ Add…" intercepts for category / vendor <select>s ────────────────
// Shared by Review and the Ledger so that adding an account or vendor mid-entry
// behaves identically everywhere: choosing the "＋ Add…" sentinel opens the quick-add
// modal WITHOUT disturbing the current selection, and on success the new option is
// appended and auto-selected, then a synthetic `change` fires so any value-gated
// control (e.g. an Approve button) updates.
import { el } from './ui.js';
import { quickAddAccountModal } from './views/accounts.js';
import { quickAddVendorModal } from './views/vendors.js';

export const NEW_CATEGORY = '__new__';
export const NEW_VENDOR = '__newvendor__';

function autoSelectNew(sel, markerValue, created) {
  const marker = sel.querySelector(`option[value="${markerValue}"]`);
  const opt = el('option', { value: created.id }, created.name);
  marker ? marker.before(opt) : sel.append(opt);
  sel.value = created.id;
  sel.dispatchEvent(new Event('change'));
}

export function attachAddCategory(sel, initialValue = '', defaultType = 'expense') {
  let prevVal = initialValue || '';
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_CATEGORY) { prevVal = sel.value; return; }
    sel.value = prevVal; // keep the row looking unchanged while the modal is open
    quickAddAccountModal((account) => { autoSelectNew(sel, NEW_CATEGORY, account); prevVal = account.id; }, defaultType);
  });
}

export function attachAddVendor(sel, initialValue = '', oncreated) {
  let prevVal = initialValue || '';
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_VENDOR) { prevVal = sel.value; return; }
    sel.value = prevVal;
    quickAddVendorModal((vendor) => { autoSelectNew(sel, NEW_VENDOR, vendor); prevVal = vendor.id; oncreated?.(vendor); });
  });
}
