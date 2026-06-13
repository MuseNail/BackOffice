// ── lib: industry → starting chart of accounts ────────────────
// Pure data + helpers, no DOM. qbType uses QuickBooks Desktop IIF !ACCNT
// vocabulary (BANK, OCASSET, OCLIAB, CCARD, EQUITY, INC, COGS, EXP) so the
// M12 export maps 1:1 with no translation layer.

export const INDUSTRIES = [
  { id: 'salon-spa', label: 'Salon / Spa', icon: 'content_cut' },
  { id: 'retail', label: 'Retail', icon: 'storefront' },
  { id: 'restaurant', label: 'Restaurant', icon: 'restaurant' },
  { id: 'rental', label: 'Rental / Real estate', icon: 'home_work' },
  { id: 'services', label: 'Services / Trades', icon: 'construction' },
  { id: 'general', label: 'General', icon: 'category' },
];

// other-expense / personal-expense are below-the-line on the P&L (after net
// ordinary income) — they still reduce the final adjusted net income.
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'cogs', 'expense', 'other-expense', 'personal-expense'];
export const QB_TYPES = ['BANK', 'OCASSET', 'FIXASSET', 'OCLIAB', 'LTLIAB', 'CCARD', 'EQUITY', 'INC', 'COGS', 'EXP'];

const A = (id, name, type, qbType, qbName = name) => ({ id, name, type, qbType, qbName, active: true });

const COMMON = [
  A('checking', 'Checking', 'asset', 'BANK'),
  A('cash-on-hand', 'Cash on hand', 'asset', 'BANK'),
  A('owner-equity', 'Owner equity', 'equity', 'EQUITY', "Owner's Equity"),
  A('owner-draw', 'Owner draw', 'equity', 'EQUITY'),
  A('rent', 'Rent', 'expense', 'EXP'),
  A('utilities', 'Utilities', 'expense', 'EXP'),
  A('insurance', 'Insurance', 'expense', 'EXP'),
  A('payroll', 'Payroll', 'expense', 'EXP', 'Payroll Expenses'),
  A('advertising', 'Advertising', 'expense', 'EXP'),
  A('bank-fees', 'Bank & processing fees', 'expense', 'EXP'),
  A('auto-travel', 'Auto & travel', 'expense', 'EXP'),
  A('office-supplies', 'Office supplies & software', 'expense', 'EXP'),
  A('professional-fees', 'Professional fees', 'expense', 'EXP'),
  A('taxes-licenses', 'Taxes & licenses', 'expense', 'EXP'),
  A('other-expense', 'Other expense', 'expense', 'EXP'),
];

const BY_INDUSTRY = {
  'salon-spa': [
    A('service-income', 'Service income', 'income', 'INC'),
    A('product-sales', 'Product sales', 'income', 'INC'),
    A('tips-payable', 'Tips payable', 'liability', 'OCLIAB'),
    A('gift-cards', 'Gift cards outstanding', 'liability', 'OCLIAB', 'Gift Certificates'),
    A('supplies-salon', 'Supplies — salon', 'expense', 'EXP', 'Supplies'),
    A('inventory', 'Inventory on hand', 'asset', 'OCASSET', 'Inventory Asset'),
    A('booth-rent-income', 'Booth rent income', 'income', 'INC'),
  ],
  retail: [
    A('sales', 'Sales', 'income', 'INC'),
    A('refunds', 'Refunds & returns', 'income', 'INC'),
    A('cogs', 'Cost of goods sold', 'cogs', 'COGS'),
    A('inventory', 'Inventory on hand', 'asset', 'OCASSET', 'Inventory Asset'),
    A('merchant-fees', 'Merchant fees', 'expense', 'EXP'),
    A('shipping', 'Shipping & freight', 'expense', 'EXP'),
  ],
  restaurant: [
    A('food-sales', 'Food sales', 'income', 'INC'),
    A('beverage-sales', 'Beverage sales', 'income', 'INC'),
    A('tips-payable', 'Tips payable', 'liability', 'OCLIAB'),
    A('cogs-food', 'Cost of goods — food', 'cogs', 'COGS'),
    A('cogs-beverage', 'Cost of goods — beverage', 'cogs', 'COGS'),
    A('inventory', 'Inventory on hand', 'asset', 'OCASSET', 'Inventory Asset'),
    A('smallwares', 'Smallwares & supplies', 'expense', 'EXP'),
  ],
  rental: [
    A('rent-income', 'Rent income', 'income', 'INC'),
    A('late-fees', 'Late fee income', 'income', 'INC'),
    A('deposits-held', 'Security deposits held', 'liability', 'OCLIAB'),
    A('repairs', 'Repairs & maintenance', 'expense', 'EXP'),
    A('property-tax', 'Property tax', 'expense', 'EXP'),
    A('mortgage-interest', 'Mortgage interest', 'expense', 'EXP'),
    A('hoa-fees', 'HOA fees', 'expense', 'EXP'),
  ],
  services: [
    A('service-income', 'Service income', 'income', 'INC'),
    A('materials', 'Materials & parts', 'cogs', 'COGS'),
    A('subcontractors', 'Subcontractors', 'cogs', 'COGS'),
    A('equipment', 'Tools & equipment', 'expense', 'EXP'),
    A('vehicle', 'Vehicle & fuel', 'expense', 'EXP'),
  ],
  general: [
    A('income', 'Income', 'income', 'INC'),
    A('cogs', 'Cost of goods sold', 'cogs', 'COGS'),
    A('supplies', 'Supplies', 'expense', 'EXP'),
  ],
};

export function industryLabel(id) {
  return INDUSTRIES.find(i => i.id === id)?.label || id;
}

// "Supplies › Gel Polish" — how a subaccount reads anywhere accounts are picked
// or reported. byIdMap: Map(accountId → account).
export function accountLabel(a, byIdMap) {
  const parent = a.parentId ? byIdMap.get(a.parentId) : null;
  return parent ? `${parent.name} › ${a.name}` : a.name;
}

export function coaFor(industry) {
  return [...(BY_INDUSTRY[industry] || BY_INDUSTRY.general), ...COMMON].map(a => ({ ...a }));
}
