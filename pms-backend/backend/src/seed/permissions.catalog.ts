/**
 * Every permission the system knows about. Later modules add their own entries here.
 * Code format: <module>.<action>
 */
export const PERMISSIONS: Array<{ code: string; description: string }> = [
  { code: 'users.read', description: 'View users' },
  { code: 'users.create', description: 'Create users' },
  { code: 'users.update', description: 'Edit user details' },
  { code: 'users.deactivate', description: 'Deactivate and reactivate users' },
  { code: 'users.reset_password', description: 'Issue a temporary password for a user' },
  { code: 'users.assign_roles', description: 'Assign and remove roles for users' },
  { code: 'roles.read', description: 'View roles' },
  { code: 'roles.manage', description: 'Create roles and change role permissions' },
  { code: 'permissions.read', description: 'View the permission catalog' },
  { code: 'sessions.revoke_any', description: "End any user's sessions" },
  { code: 'login_history.read', description: 'View sign-in history' },
  { code: 'branches.read', description: 'View branches' },
  { code: 'branches.manage', description: 'Create and edit branches' },
  { code: 'employees.read', description: 'View employees' },
  { code: 'employees.manage', description: 'Create and edit employees and departments' },
  { code: 'audit.read', description: 'View the audit log' },
  { code: 'settings.read', description: 'View settings and document numbering' },
  { code: 'settings.manage', description: 'Change settings and document numbering' },
  { code: 'tax.read', description: 'View tax categories and rules' },
  { code: 'tax.manage', description: 'Manage tax categories and rules' },
  { code: 'warehouses.read', description: 'View warehouses and storage locations' },
  { code: 'warehouses.manage', description: 'Manage warehouses and storage locations' },
  { code: 'registers.read', description: 'View cash registers' },
  { code: 'registers.manage', description: 'Manage cash registers' },
  { code: 'suppliers.read', description: 'View suppliers' },
  { code: 'suppliers.manage', description: 'Create and edit suppliers' },
  { code: 'products.read', description: 'View products, categories, units and prices' },
  { code: 'products.create', description: 'Register new products' },
  { code: 'products.update', description: 'Edit products, units and barcodes' },
  { code: 'prices.change', description: 'Change product prices' },
  { code: 'inventory.read', description: 'View stock, batches, movements and stock reports' },
  { code: 'inventory.adjust', description: 'Request stock adjustments; quarantine and damage stock; run the expiry sweep' },
  { code: 'inventory.adjust_approve', description: 'Approve stock adjustments; run stock reconciliation' },
  { code: 'inventory.release_quarantine', description: 'Release quarantined stock back to saleable stock after inspection' },
  { code: 'inventory.dispose', description: 'Request disposal of expired, damaged or returned stock' },
  { code: 'inventory.dispose_approve', description: 'Approve disposals of stock' },
  { code: 'inventory.transfer', description: 'Request, dispatch and receive stock transfers' },
  { code: 'inventory.transfer_approve', description: 'Approve stock transfers' },
  { code: 'inventory.count', description: 'Run physical stock counts' },
  { code: 'inventory.count_approve', description: 'Approve physical count results' },
  { code: 'prices.approve', description: 'Approve bulk price updates' },
  { code: 'procurement.read', description: 'View purchase requests, orders, receipts, invoices, payments and supplier balances' },
  { code: 'procurement.request', description: 'Create purchase requests' },
  { code: 'procurement.request_approve', description: 'Approve purchase requests' },
  { code: 'procurement.order', description: 'Create, edit, cancel and close purchase orders' },
  { code: 'procurement.order_approve', description: 'Approve purchase orders and order changes' },
  { code: 'procurement.receive', description: 'Record deliveries from suppliers' },
  { code: 'procurement.inspect', description: 'Inspect delivered goods and accept or reject them' },
  { code: 'procurement.invoice', description: 'Record supplier invoices' },
  { code: 'procurement.invoice_approve', description: 'Approve supplier invoices that differ from the goods received' },
  { code: 'procurement.pay', description: 'Record supplier payments and apply credits' },
  { code: 'procurement.payment_reverse', description: 'Reverse supplier payments' },
  { code: 'procurement.return', description: 'Request returns to suppliers' },
  { code: 'procurement.return_approve', description: 'Approve returns to suppliers' },
  { code: 'dashboards.management', description: 'Open the management dashboards' },
  { code: 'sync.manage', description: 'View and revoke registered point-of-sale devices' },
  { code: 'sync.resolve', description: 'Resolve offline sales that could not be accepted' },
  { code: 'jobs.run', description: 'View and start the scheduled background checks' },
  { code: 'finance.read', description: 'View the chart of accounts, journal, expenses, income and financial reports' },
  { code: 'finance.accounts_manage', description: 'Change the chart of accounts and posting accounts' },
  { code: 'finance.period_manage', description: 'Create, close and reopen accounting periods' },
  { code: 'finance.journal_create', description: 'Request a manual journal entry' },
  { code: 'finance.journal_approve', description: 'Approve manual journal entries' },
  { code: 'finance.expense_create', description: 'Record expenses' },
  { code: 'finance.expense_approve', description: 'Approve large expenses' },
  { code: 'finance.expense_reverse', description: 'Reverse expenses and other income' },
  { code: 'finance.income_manage', description: 'Record other business income' },
  { code: 'finance.register_operate', description: 'Open and close cash register sessions' },
  { code: 'finance.register_review', description: 'Review register sessions with a cash difference and see every cashier\'s sessions' },
  { code: 'sales.read', description: 'View sales, receipts and sales reports' },
  { code: 'sales.create', description: 'Sell at the point of sale' },
  { code: 'sales.discount_request', description: 'Ask for a discount above the normal limit' },
  { code: 'sales.discount_approve', description: 'Approve discounts above the normal limit' },
  { code: 'sales.cancel', description: 'Request cancellation of a completed sale' },
  { code: 'sales.cancel_approve', description: 'Approve cancellation of a completed sale' },
  { code: 'sales.return', description: 'Take back goods from a customer' },
  { code: 'sales.return_approve', description: 'Approve customer returns' },
  { code: 'sales.return_inspect', description: 'Inspect returned goods and decide whether they can be sold again' },
  { code: 'sales.configure', description: 'Manage payment methods' },
  { code: 'customers.read', description: 'View customers and their balances' },
  { code: 'customers.manage', description: 'Register and edit customers' },
  { code: 'customers.credit', description: 'Sell to customers on account (credit)' },
  { code: 'customers.payment', description: 'Receive payments from customers on account' },
  { code: 'customers.payment_reverse', description: 'Reverse customer payments' },
  { code: 'prescriptions.read', description: 'View prescriptions (personal health information)' },
  { code: 'prescriptions.manage', description: 'Register prescriptions' },
  { code: 'prescriptions.validate', description: 'Validate or reject prescriptions' },
  { code: 'catalog.manage', description: 'Manage categories, manufacturers, units and dosage forms' },
];

const FIN_READ = ['finance.read'];
const ALL = PERMISSIONS.map((p) => p.code);
const PROC_ALL = ['procurement.read', 'procurement.request', 'procurement.request_approve', 'procurement.order', 'procurement.order_approve', 'procurement.receive', 'procurement.inspect', 'procurement.invoice', 'procurement.invoice_approve', 'procurement.pay', 'procurement.payment_reverse', 'procurement.return', 'procurement.return_approve'];
const SALES_APPROVE = ['sales.discount_approve', 'sales.cancel_approve', 'sales.return_approve', 'sales.return_inspect', 'customers.payment_reverse', 'prescriptions.validate'];
const READS = ['finance.read', 'sales.read', 'customers.read', 'procurement.read', 'settings.read', 'tax.read', 'warehouses.read', 'registers.read', 'suppliers.read', 'products.read', 'inventory.read'];
const STOCK_OPS = ['inventory.adjust', 'inventory.release_quarantine', 'inventory.dispose', 'inventory.transfer', 'inventory.count'];
const STOCK_APPROVE = ['inventory.adjust_approve', 'inventory.dispose_approve', 'inventory.transfer_approve', 'inventory.count_approve'];
const READ_ORG = ['branches.read', 'employees.read', 'users.read'];
const READ_ALL = ['dashboards.management', 'users.read', 'roles.read', 'permissions.read', 'branches.read', 'employees.read', 'audit.read', 'login_history.read', ...READS];

/**
 * Starting roles. Each (role, permission) pair is granted once, the first time the seed sees it; after
 * that administrators own it, so removing a permission from a role is never undone by re-seeding.
 */
export const DEFAULT_ROLES: Array<{ name: string; description: string; permissions: string[] }> = [
  { name: 'System Administrator', description: 'Full control of users, roles, branches and settings', permissions: ALL },
  { name: 'CEO', description: 'Executive oversight across all branches', permissions: READ_ALL },
  { name: 'Pharmacy Owner', description: 'Business owner oversight across all branches', permissions: READ_ALL },
  { name: 'Pharmacy Manager', description: 'Manages pharmacy operations', permissions: ['dashboards.management', 'sync.manage', 'sync.resolve', 'finance.accounts_manage', 'finance.period_manage', 'finance.journal_create', 'finance.journal_approve', 'finance.expense_create', 'finance.expense_approve', 'finance.expense_reverse', 'finance.income_manage', 'finance.register_operate', 'finance.register_review', ...READ_ORG, ...READS, 'products.create', 'products.update', 'prices.change', 'prices.approve', 'suppliers.manage', ...STOCK_OPS, ...STOCK_APPROVE, ...PROC_ALL, ...SALES_APPROVE, 'sales.create', 'sales.discount_request', 'sales.cancel', 'sales.return', 'sales.configure', 'customers.manage', 'customers.credit', 'customers.payment', 'prescriptions.read', 'prescriptions.manage'] },
  { name: 'Branch Manager', description: 'Manages one branch', permissions: ['dashboards.management', 'sync.manage', 'sync.resolve', 'finance.read', 'finance.expense_create', 'finance.expense_approve', 'finance.income_manage', 'finance.register_operate', 'finance.register_review', ...READ_ORG, 'warehouses.read', 'registers.read', 'suppliers.read', 'products.read', 'inventory.read', ...STOCK_OPS, ...STOCK_APPROVE, 'procurement.read', 'sales.read', 'customers.read', 'procurement.request', 'procurement.request_approve', 'procurement.receive', 'procurement.inspect', 'procurement.return', ...SALES_APPROVE, 'sales.create', 'sales.discount_request', 'sales.cancel', 'sales.return', 'customers.manage', 'customers.credit', 'customers.payment', 'prescriptions.read', 'prescriptions.manage'] },
  { name: 'Supply Chain Manager', description: 'Procurement and stock supply', permissions: ['dashboards.management', 'branches.read', 'suppliers.read', 'suppliers.manage', 'products.read', 'warehouses.read', 'inventory.read', 'inventory.transfer', 'procurement.read', 'procurement.request', 'procurement.order', 'procurement.receive', 'procurement.inspect', 'procurement.return', 'procurement.invoice'] },
  { name: 'Sales Manager', description: 'Sales performance and targets', permissions: ['dashboards.management', 'branches.read', 'products.read', 'inventory.read', 'sales.read', 'customers.read', 'customers.manage'] },
  { name: 'Dispenser / Sales Staff', description: 'Dispensing and point of sale', permissions: ['branches.read', 'products.read', 'inventory.read', 'sales.read', 'sales.create', 'sales.discount_request', 'sales.cancel', 'sales.return', 'customers.read', 'customers.manage', 'prescriptions.read', 'prescriptions.manage'] },
  { name: 'Storekeeper', description: 'Stock receiving and storage', permissions: ['branches.read', 'products.read', 'warehouses.read', 'suppliers.read', 'inventory.read', 'inventory.adjust', 'inventory.dispose', 'inventory.transfer', 'inventory.count', 'procurement.read', 'procurement.request', 'procurement.receive', 'procurement.inspect'] },
  { name: 'Accountant', description: 'Finance and accounting', permissions: ['dashboards.management', 'finance.read', 'finance.accounts_manage', 'finance.period_manage', 'finance.journal_create', 'finance.expense_create', 'finance.expense_reverse', 'finance.income_manage', 'branches.read', 'products.read', 'tax.read', 'suppliers.read', 'inventory.read', 'procurement.read', 'procurement.invoice', 'procurement.invoice_approve', 'procurement.pay', 'procurement.payment_reverse', 'sales.read', 'customers.read', 'customers.payment'] },
  { name: 'Cashier', description: 'Cash handling at the register', permissions: ['finance.register_operate', 'branches.read', 'products.read', 'registers.read', 'sales.read', 'sales.create', 'sales.discount_request', 'sales.return', 'customers.read', 'customers.manage', 'customers.payment'] },
  { name: 'Auditor', description: 'Read-only review including audit logs', permissions: [...READ_ALL, 'prescriptions.read'] },
];

export const DEFAULT_UNITS: Array<[string, string]> = [
  ['tablet', 'Tablet'], ['capsule', 'Capsule'], ['strip', 'Strip'], ['blister', 'Blister pack'], ['box', 'Box'],
  ['carton', 'Carton'], ['bottle', 'Bottle'], ['vial', 'Vial'], ['ampoule', 'Ampoule'], ['tube', 'Tube'],
  ['sachet', 'Sachet'], ['pack', 'Pack'], ['piece', 'Piece'], ['ml', 'Millilitre'], ['gram', 'Gram'],
];

export const DEFAULT_DOSAGE_FORMS = [
  'Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Cream', 'Ointment', 'Gel', 'Drops', 'Inhaler',
  'Suppository', 'Powder', 'Solution', 'Lotion', 'Patch', 'Spray',
];

/** Payment methods created at first install. Administrators can add, rename or deactivate them. */
export const DEFAULT_PAYMENT_METHODS: Array<{ code: string; name: string; isCash: boolean; isCredit: boolean; requiresReference: boolean; sort: number }> = [
  { code: 'cash', name: 'Cash', isCash: true, isCredit: false, requiresReference: false, sort: 10 },
  { code: 'mobile_money', name: 'Mobile money', isCash: false, isCredit: false, requiresReference: true, sort: 20 },
  { code: 'card', name: 'Card', isCash: false, isCredit: false, requiresReference: true, sort: 30 },
  { code: 'bank_transfer', name: 'Bank transfer', isCash: false, isCredit: false, requiresReference: true, sort: 40 },
  { code: 'credit', name: 'On account (credit)', isCash: false, isCredit: true, requiresReference: false, sort: 90 },
];

/** Starting chart of accounts. Administrators can rename, add and re-point accounts; "system" ones are used by automatic postings. */
export const DEFAULT_ACCOUNTS: Array<{ code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'; system: boolean }> = [
  { code: '1010', name: 'Cash on hand', type: 'asset', system: true },
  { code: '1020', name: 'Bank accounts', type: 'asset', system: true },
  { code: '1030', name: 'Mobile money', type: 'asset', system: true },
  { code: '1100', name: 'Accounts receivable (customers)', type: 'asset', system: true },
  { code: '1200', name: 'Inventory', type: 'asset', system: true },
  { code: '1250', name: 'Inventory in transit', type: 'asset', system: true },
  { code: '1300', name: 'Input tax recoverable', type: 'asset', system: true },
  { code: '1400', name: 'Supplier credits receivable', type: 'asset', system: true },
  { code: '2010', name: 'Accounts payable (suppliers)', type: 'liability', system: true },
  { code: '2020', name: 'Goods received not invoiced', type: 'liability', system: true },
  { code: '2100', name: 'Output tax payable', type: 'liability', system: true },
  { code: '3000', name: "Owner's equity", type: 'equity', system: true },
  { code: '3100', name: 'Opening balance equity', type: 'equity', system: true },
  { code: '4000', name: 'Sales revenue', type: 'revenue', system: true },
  { code: '4090', name: 'Sales returns', type: 'revenue', system: true },
  { code: '4100', name: 'Other income', type: 'revenue', system: true },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', system: true },
  { code: '5100', name: 'Stock adjustments', type: 'expense', system: true },
  { code: '5110', name: 'Damaged and expired stock written off', type: 'expense', system: true },
  { code: '6010', name: 'Rent', type: 'expense', system: false },
  { code: '6020', name: 'Salaries and wages', type: 'expense', system: false },
  { code: '6030', name: 'Utilities', type: 'expense', system: false },
  { code: '6040', name: 'Transportation', type: 'expense', system: false },
  { code: '6050', name: 'Maintenance and repairs', type: 'expense', system: false },
  { code: '6060', name: 'Operating expenses', type: 'expense', system: false },
  { code: '6900', name: 'Other expenses', type: 'expense', system: false },
  { code: '6950', name: 'Cash over and short', type: 'expense', system: true },
];
export const DEFAULT_ACCOUNT_MAPPINGS: Array<{ key: string; code: string; description: string }> = [
  { key: 'cash', code: '1010', description: 'Cash payments and the cash drawer' },
  { key: 'bank', code: '1020', description: 'Bank and card payments' },
  { key: 'payment.cash', code: '1010', description: 'Payment method: cash' },
  { key: 'payment.mobile_money', code: '1030', description: 'Payment method: mobile money' },
  { key: 'payment.card', code: '1020', description: 'Payment method: card' },
  { key: 'payment.bank_transfer', code: '1020', description: 'Payment method: bank transfer' },
  { key: 'payment.credit', code: '1100', description: 'Payment method: on account' },
  { key: 'receivable', code: '1100', description: 'What customers owe' },
  { key: 'inventory', code: '1200', description: 'Stock at cost' },
  { key: 'in_transit', code: '1250', description: 'Stock moving between branches' },
  { key: 'tax_input', code: '1300', description: 'Tax paid on purchases' },
  { key: 'supplier_credits', code: '1400', description: 'Credit due from suppliers for returned goods' },
  { key: 'payable', code: '2010', description: 'What the pharmacy owes suppliers' },
  { key: 'grni', code: '2020', description: 'Goods received, supplier invoice not yet recorded' },
  { key: 'tax_output', code: '2100', description: 'Tax collected on sales' },
  { key: 'equity', code: '3000', description: "Owner's equity" },
  { key: 'opening_equity', code: '3100', description: 'Counterpart of opening stock' },
  { key: 'revenue', code: '4000', description: 'Sales' },
  { key: 'sales_returns', code: '4090', description: 'Sales taken back' },
  { key: 'other_income', code: '4100', description: 'Income other than sales' },
  { key: 'cogs', code: '5000', description: 'Cost of the goods sold' },
  { key: 'stock_adjustment', code: '5100', description: 'Stock found or lost on counts and adjustments' },
  { key: 'stock_writeoff', code: '5110', description: 'Damaged and expired stock destroyed' },
  { key: 'cash_over_short', code: '6950', description: 'Register differences' },
];
export const DEFAULT_EXPENSE_CATEGORIES: Array<{ code: string; name: string; account: string }> = [
  { code: 'rent', name: 'Rent', account: '6010' }, { code: 'salaries', name: 'Salaries', account: '6020' }, { code: 'utilities', name: 'Utilities', account: '6030' },
  { code: 'transport', name: 'Transportation', account: '6040' }, { code: 'maintenance', name: 'Maintenance', account: '6050' },
  { code: 'operations', name: 'Operational expenses', account: '6060' }, { code: 'other', name: 'Other expenses', account: '6900' },
];
export const DEFAULT_INCOME_CATEGORIES: Array<{ code: string; name: string; account: string }> = [
  { code: 'other_income', name: 'Other business income', account: '4100' },
];
