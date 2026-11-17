import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './ui/Layout';
import { Spinner } from './ui/kit';
import { Account, Login } from './pages/Login';

const L = <T extends Record<string, any>>(f: () => Promise<T>, name: keyof T) => lazy(async () => ({ default: (await f())[name] as React.ComponentType }));
const admin = () => import('./pages/admin');
const catalog = () => import('./pages/catalog');
const stock = () => import('./pages/stock');
const sales = () => import('./pages/sales');
const buying = () => import('./pages/buying');
const finance = () => import('./pages/finance');
const insight = () => import('./pages/insight');

const R: Array<[string, React.LazyExoticComponent<React.ComponentType>]> = [
  ['/', L(insight, 'Home')], ['/approvals', L(insight, 'Approvals')], ['/notifications', L(insight, 'Notifications')], ['/reports', L(insight, 'Reports')],
  ['/pos', L(() => import('./pos/Pos'), 'Pos')],
  ['/sales', L(sales, 'SalesPage')], ['/returns', L(sales, 'ReturnsPage')], ['/customers', L(sales, 'CustomersPage')], ['/prescriptions', L(sales, 'PrescriptionsPage')],
  ['/register-session', L(sales, 'RegisterSessionPage')], ['/offline', L(sales, 'OfflinePage')],
  ['/products', L(catalog, 'ProductsPage')], ['/import', L(catalog, 'ImportPage')], ['/price-updates', L(catalog, 'PriceUpdatesPage')],
  ['/stock', L(stock, 'StockPage')], ['/adjustments', L(stock, 'AdjustmentsPage')], ['/disposals', L(stock, 'DisposalsPage')], ['/transfers', L(stock, 'TransfersPage')], ['/counts', L(stock, 'CountsPage')],
  ['/suppliers', L(buying, 'SuppliersPage')], ['/reorder', L(buying, 'ReorderPage')], ['/purchase-requests', L(buying, 'PurchaseRequestsPage')], ['/purchase-orders', L(buying, 'PurchaseOrdersPage')],
  ['/receipts', L(buying, 'ReceiptsPage')], ['/supplier-invoices', L(buying, 'SupplierInvoicesPage')], ['/supplier-payments', L(buying, 'SupplierPaymentsPage')], ['/purchase-returns', L(buying, 'PurchaseReturnsPage')],
  ['/finance/expenses', L(finance, 'ExpensesPage')], ['/finance/income', L(finance, 'IncomePage')], ['/finance/journal', L(finance, 'JournalPage')], ['/finance/accounts', L(finance, 'AccountsPage')],
  ['/finance/periods', L(finance, 'PeriodsPage')], ['/finance/statements', L(finance, 'StatementsPage')], ['/finance/sessions', L(finance, 'SessionsPage')],
  ['/admin/branches', L(admin, 'BranchesPage')], ['/admin/warehouses', L(admin, 'WarehousesPage')], ['/admin/registers', L(admin, 'RegistersPage')], ['/admin/employees', L(admin, 'EmployeesPage')],
  ['/admin/users', L(admin, 'UsersPage')], ['/admin/roles', L(admin, 'RolesPage')], ['/admin/catalog-lists', L(admin, 'CatalogListsPage')], ['/admin/tax', L(admin, 'TaxPage')],
  ['/admin/payment-methods', L(admin, 'PaymentMethodsPage')], ['/admin/settings', L(admin, 'SettingsPage')], ['/admin/numbering', L(admin, 'NumberingPage')], ['/admin/devices', L(admin, 'DevicesPage')],
  ['/admin/conflicts', L(admin, 'ConflictsPage')], ['/admin/jobs', L(admin, 'JobsPage')], ['/admin/audit', L(admin, 'AuditPage')],
];

function Guard({ children }: { children: JSX.Element }) {
  const { me, loading } = useAuth(); const loc = useLocation();
  if (loading) return <Spinner text="Starting…" />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.user.must_change_password && loc.pathname !== '/account') return <Navigate to="/account" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Guard><Layout /></Guard>}>
        {R.map(([p, C]) => <Route key={p} path={p} element={<Suspense fallback={<Spinner />}><C /></Suspense>} />)}
        <Route path="/account" element={<Account />} />
        <Route path="*" element={
          <div className="card text-center py-16 max-w-lg mx-auto shadow-sm">
            <div className="text-4xl font-black text-brand-600/30 dark:text-brand-400/20 mb-2">404</div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">Page not found</h2>
            <p className="text-sm text-slate-500 mt-1 mb-4">The page you are looking for does not exist or has moved.</p>
            <a href="/" className="btn-primary inline-flex items-center gap-1.5 py-1.5 px-4 text-xs font-semibold">
              Return to Dashboard
            </a>
          </div>
        } />
      </Route>
    </Routes>
  );
}
