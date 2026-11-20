import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, label } from '../lib/format';
import { ResourcePage, useOne } from '../ui/resource';
import {
  ActionButton, AutoTable, Badge, DataTable, Empty, ErrorBox, FieldDef, FormModal, KeyValues, Modal, PageHeader, Pager, Spinner, Tabs, useLookup, usePagedList, useToast, FormFields, initialValues, cleanValues, SearchBox, useDebounced,
} from '../ui/kit';

const branchLookup = { path: '/branches' };
const STATUS = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];

export const BranchesPage = () => <ResourcePage cfg={{
  title: 'Branches', path: '/branches',
  columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'address', header: 'Address' }, { key: 'phone', header: 'Phone' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'is_central', header: 'Central', type: 'bool' }],
  create: { permission: 'branches.manage', fields: [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'address', label: 'Address' }, { name: 'phone', label: 'Phone' }, { name: 'isCentral', label: 'Central branch', type: 'checkbox', help: 'Central branch (head office)' }] },
  edit: { permission: 'branches.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'address', label: 'Address' }, { name: 'phone', label: 'Phone' }, { name: 'status', label: 'Status', type: 'select', options: STATUS, required: true }] },
}} />;

function Locations({ warehouse, onClose }: { warehouse: Row; onClose(): void }) {
  const q = useQuery({ queryKey: ['locs', warehouse.id], queryFn: async () => (await api.list('/storage-locations', { warehouseId: warehouse.id })).items });
  const qc = useQueryClient(); const toast = useToast(); const [adding, setAdding] = useState(false);
  const fields: FieldDef[] = [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'temperatureZone', label: 'Temperature zone', type: 'select', options: ['ambient', 'cool', 'cold', 'frozen'].map((v) => ({ value: v, label: label(v) })), default: 'ambient' }];
  return (
    <Modal title={`Storage locations · ${warehouse.name}`} onClose={onClose} footer={<button className="btn-primary" onClick={() => setAdding(true)}>Add location</button>}>
      {q.isLoading ? <Spinner /> : q.data?.length ? <DataTable columns={[{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'temperature_zone', header: 'Zone', type: 'badge' }, { key: 'status', header: 'Status', type: 'badge' }]} rows={q.data} /> : <Empty text="No locations yet. Stock can still be held without them." />}
      {adding && <FormModal title="Add storage location" fields={fields} onClose={() => setAdding(false)} onSubmit={async (v) => { await api.post('/storage-locations', { ...v, warehouseId: warehouse.id }); toast.ok('Saved'); void qc.invalidateQueries({ queryKey: ['locs'] }); }} />}
    </Modal>
  );
}
export function WarehousesPage() {
  const [loc, setLoc] = useState<Row | null>(null);
  return <>
    <ResourcePage cfg={{
      title: 'Warehouses', path: '/warehouses',
      columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'branch_id', header: 'Branch', render: (r) => <BranchName id={r.branch_id} /> }, { key: 'status', header: 'Status', type: 'badge' }],
      create: { permission: 'warehouses.manage', fields: [{ name: 'branchId', label: 'Branch', type: 'lookup', lookup: branchLookup, required: true }, { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }] },
      edit: { permission: 'warehouses.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'status', label: 'Status', type: 'select', options: STATUS, required: true }] },
      rowActions: (r) => <button className="btn-ghost py-1" onClick={() => setLoc(r)}>Locations</button>,
    }} />
    {loc && <Locations warehouse={loc} onClose={() => setLoc(null)} />}
  </>;
}
export function BranchName({ id }: { id?: string | null }) {
  const b = useLookup('/branches'); return <>{b.data?.find((x) => x.id === id)?.name ?? (id ? '…' : '—')}</>;
}

export const RegistersPage = () => <ResourcePage cfg={{
  title: 'Cash registers', subtitle: 'A register is a till. Each tablet is linked to one register.', path: '/cash-registers',
  columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'branch_id', header: 'Branch', render: (r) => <BranchName id={r.branch_id} /> }, { key: 'offline_mode', header: 'Offline mode', type: 'badge' }, { key: 'status', header: 'Status', type: 'badge' }],
  create: { permission: 'registers.manage', fields: [{ name: 'branchId', label: 'Branch', type: 'lookup', lookup: branchLookup, required: true }, { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'offlineMode', label: 'Offline mode', type: 'select', default: 'offline_capable', options: ['online_only', 'offline_capable', 'hybrid'].map((v) => ({ value: v, label: label(v) })) }] },
  edit: { permission: 'registers.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'offlineMode', label: 'Offline mode', type: 'select', options: ['online_only', 'offline_capable', 'hybrid'].map((v) => ({ value: v, label: label(v) })) }, { name: 'status', label: 'Status', type: 'select', options: STATUS, required: true }] },
}} />;

export const EmployeesPage = () => <ResourcePage cfg={{
  title: 'Employees', path: '/employees', searchable: true,
  columns: [{ key: 'full_name', header: 'Name' }, { key: 'job_title', header: 'Job title' }, { key: 'branch_id', header: 'Branch', render: (r) => <BranchName id={r.branch_id} /> }, { key: 'phone', header: 'Phone' }, { key: 'employment_status', header: 'Status', type: 'badge' }],
  create: { permission: 'employees.manage', fields: [{ name: 'fullName', label: 'Full name', required: true }, { name: 'branchId', label: 'Branch', type: 'lookup', lookup: branchLookup, required: true }, { name: 'departmentId', label: 'Department', type: 'lookup', lookup: { path: '/departments' } }, { name: 'jobTitle', label: 'Job title' }, { name: 'hireDate', label: 'Hire date', type: 'date' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }] },
  edit: { permission: 'employees.manage', fields: [{ name: 'fullName', label: 'Full name', required: true }, { name: 'branchId', label: 'Branch', type: 'lookup', lookup: branchLookup }, { name: 'departmentId', label: 'Department', type: 'lookup', lookup: { path: '/departments' } }, { name: 'jobTitle', label: 'Job title' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'employmentStatus', label: 'Employment', type: 'select', options: ['active', 'on_leave', 'terminated'].map((v) => ({ value: v, label: label(v) })) }] },
}} />;

// The API can only list and create departments (no rename or delete), so this page has no edit form.
export const DepartmentsPage = () => <ResourcePage cfg={{
  title: 'Departments', subtitle: 'Used to group employees, for example Dispensary, Store or Finance.', path: '/departments', detail: false,
  columns: [{ key: 'name', header: 'Name' }],
  create: { permission: 'employees.manage', fields: [{ name: 'name', label: 'Name', required: true }] },
}} />;

// ---------- users ----------
function RoleAssign({ user, onClose, onDone }: { user: Row; onClose(): void; onDone(): void }) {
  const detail = useOne(`/users/${user.id}`, ['user', user.id]); const roles = useLookup('/roles'); const toast = useToast();
  const [rows, setRows] = useState<Array<{ roleId: string; branchId: string }> | null>(null);
  const cur = rows ?? (detail.data?.roles ?? []).map((r: Row) => ({ roleId: r.role_id, branchId: r.branch_id ?? '' }));
  if (detail.isLoading || roles.isLoading) return <Modal title="Roles" onClose={onClose}><Spinner /></Modal>;
  return (
    <Modal title={`Roles · ${user.username}`} onClose={onClose} footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button>
      <ActionButton className="btn-primary" run={async () => { await api.put(`/users/${user.id}/roles`, { roles: cur.map((r: any) => ({ roleId: r.roleId, ...(r.branchId ? { branchId: r.branchId } : {}) })) }); toast.ok('Roles saved'); onDone(); onClose(); }}>Save roles</ActionButton></>}>
      <p className="mb-2 text-sm text-slate-500">Choose a branch to limit the role to that branch. Leave it on “All branches” for the whole business.</p>
      {cur.map((r: any, i: number) => (
        <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_auto] gap-2">
          <select className="input" value={r.roleId} onChange={(e) => setRows(cur.map((x: any, j: number) => (j === i ? { ...x, roleId: e.target.value } : x)))}>{roles.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <BranchSelect value={r.branchId} onChange={(v) => setRows(cur.map((x: any, j: number) => (j === i ? { ...x, branchId: v } : x)))} />
          <button className="text-red-600" aria-label="Remove role" onClick={() => setRows(cur.filter((_: any, j: number) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn-ghost" onClick={() => setRows([...cur, { roleId: roles.data?.[0]?.id ?? '', branchId: '' }])}>Add role</button>
    </Modal>
  );
}
const BranchSelect = ({ value, onChange, all = 'All branches' }: { value: string; onChange(v: string): void; all?: string }) => {
  const b = useLookup('/branches');
  return <select className="input" value={value} onChange={(e) => onChange(e.target.value)}><option value="">{all}</option>{b.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>;
};
export function UsersPage() {
  const { can } = useAuth(); const [assign, setAssign] = useState<Row | null>(null); const [temp, setTemp] = useState<{ user: string; pw: string } | null>(null); const qc = useQueryClient(); const toast = useToast();
  const reload = () => void qc.invalidateQueries({ queryKey: ['list', '/users'] });
  
  return <>
    <ResourcePage cfg={{
      title: 'Users', path: '/users', searchable: true,
      columns: [{ key: 'username', header: 'Username' }, { key: 'full_name', header: 'Employee' }, { key: 'email', header: 'Email' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'last_login_at', header: 'Last sign-in', type: 'datetime' }],
      create: { permission: 'users.create', label: 'Add user', fields: [{ name: 'username', label: 'Username', required: true }, { name: 'email', label: 'Email', type: 'email' }, { name: 'employeeId', label: 'Employee', type: 'lookup', lookup: { path: '/employees', label: 'full_name' } }, { name: 'password', label: 'Password', type: 'password', help: 'Leave empty to generate a temporary password.' }, { name: 'roleId', label: 'Role', type: 'lookup', lookup: { path: '/roles' } }, { name: 'roleBranchId', label: 'Limit role to branch', type: 'lookup', lookup: branchLookup }],
        transform: (v) => { const { roleId, roleBranchId, ...rest } = v; return { ...rest, ...(roleId ? { roles: [{ roleId, ...(roleBranchId ? { branchId: roleBranchId } : {}) }] } : {}) }; } },
      edit: { permission: 'users.update', fields: [{ name: 'email', label: 'Email', type: 'email' }, { name: 'employeeId', label: 'Employee', type: 'lookup', lookup: { path: '/employees', label: 'full_name' } }] },
      rowActions: (r, reload2) => <>
        {can('users.assign_roles') && <button className="btn-ghost py-1" onClick={() => setAssign(r)}>Roles</button>}
        {can('users.reset_password') && <ActionButton className="btn-ghost py-1" confirm={`Reset the password for ${r.username}? They must choose a new one at next sign-in.`} run={async () => { const x = await api.post(`/users/${r.id}/reset-password`); setTemp({ user: r.username, pw: x.temporaryPassword }); }}>Reset password</ActionButton>}
        {can('users.deactivate') && <ActionButton className="btn-ghost py-1" confirm={r.status === 'active' ? `Deactivate ${r.username}? They are signed out immediately.` : undefined} run={async () => { await api.post(`/users/${r.id}/${r.status === 'active' ? 'deactivate' : 'activate'}`); toast.ok('Updated'); reload2(); }}>{r.status === 'active' ? 'Deactivate' : 'Activate'}</ActionButton>}
      </>,
    }} />
    {assign && <RoleAssign user={assign} onClose={() => setAssign(null)} onDone={reload} />}
    {temp && <Modal title="Temporary password" onClose={() => setTemp(null)}><p className="text-sm">Give this to <b>{temp.user}</b> once. It is not shown again.</p><p className="my-3 select-all rounded bg-slate-100 p-3 text-center font-mono text-xl dark:bg-slate-800">{temp.pw}</p></Modal>}
  </>;
}

// ---------- roles ----------
function PermissionMatrix({ role, onClose, onDone }: { role: Row; onClose(): void; onDone(): void }) {
  const perms = useLookup('/permissions'); const detail = useOne(`/roles/${role.id}`, ['role', role.id]); const toast = useToast();
  const [sel, setSel] = useState<Set<string> | null>(null);
  const cur = sel ?? new Set<string>(detail.data?.permissions ?? []);
  const groups = useMemo(() => { const g: Record<string, Row[]> = {}; for (const p of perms.data ?? []) (g[p.module] ??= []).push(p); return g; }, [perms.data]);
  const toggle = (c: string) => { const n = new Set(cur); n.has(c) ? n.delete(c) : n.add(c); setSel(n); };
  if (perms.isLoading || detail.isLoading) return <Modal title="Permissions" onClose={onClose}><Spinner /></Modal>;
  return (
    <Modal wide title={`Permissions · ${role.name}`} onClose={onClose} footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button>
      <ActionButton className="btn-primary" run={async () => { await api.put(`/roles/${role.id}/permissions`, { version: detail.data!.version, permissions: [...cur] }); toast.ok('Permissions saved'); onDone(); onClose(); }}>Save</ActionButton></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {Object.entries(groups).map(([m, ps]) => (
          <div key={m}><div className="mb-1 text-sm font-semibold capitalize">{label(m)}</div>
            {ps.map((p) => <label key={p.code} className="flex items-start gap-2 py-0.5 text-sm"><input type="checkbox" className="mt-1" checked={cur.has(p.code)} onChange={() => toggle(p.code)} /><span>{p.description}<span className="block text-[10px] text-slate-400">{p.code}</span></span></label>)}
          </div>
        ))}
      </div>
    </Modal>
  );
}
export function RolesPage() {
  const [m, setM] = useState<Row | null>(null); const qc = useQueryClient();
  return <>
    <ResourcePage cfg={{
      title: 'Roles', subtitle: 'A role is a bundle of permissions. Assign roles to people under Users.', path: '/roles',
      columns: [{ key: 'name', header: 'Role' }, { key: 'description', header: 'Description' }, { key: 'permission_count', header: 'Permissions', align: 'right' }, { key: 'user_count', header: 'People', align: 'right' }, { key: 'is_system', header: 'Built-in', type: 'bool' }],
      create: { permission: 'roles.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' }] },
      edit: { permission: 'roles.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' }] },
      rowActions: (r) => <button className="btn-ghost py-1" onClick={() => setM(r)}>Permissions</button>, detail: false,
    }} />
    {m && <PermissionMatrix role={m} onClose={() => setM(null)} onDone={() => void qc.invalidateQueries({ queryKey: ['list', '/roles'] })} />}
  </>;
}

// ---------- product lists ----------
const nameOnly = (title: string, path: string, perm = 'catalog.manage', extra: FieldDef[] = []) => (
  <ResourcePage cfg={{ title, path, columns: [{ key: 'name', header: 'Name' }, ...extra.map((f) => ({ key: f.name, header: f.label }))], create: { permission: perm, fields: [{ name: 'name', label: 'Name', required: true }, ...extra] }, edit: { permission: perm, fields: [{ name: 'name', label: 'Name', required: true }, ...extra] } }} />
);
export function CatalogListsPage() {
  const [tab, setTab] = useState('units');
  return (
    <div>
      <PageHeader title="Product lists" subtitle="Units, dosage forms, categories and manufacturers used when adding products." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'units', label: 'Units' }, { id: 'forms', label: 'Dosage forms' }, { id: 'cats', label: 'Categories' }, { id: 'mfr', label: 'Manufacturers' }]} />
      <div className="mt-3">
        {tab === 'units' && <ResourcePage cfg={{ title: 'Units', path: '/units', columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'is_active', header: 'Active', type: 'bool' }], create: { permission: 'catalog.manage', fields: [{ name: 'code', label: 'Code', required: true, help: 'Short code, e.g. box, strip, tablet' }, { name: 'name', label: 'Name', required: true }] }, edit: { permission: 'catalog.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'isActive', label: 'Active', type: 'checkbox', help: 'Can be used on new products' }] } }} />}
        {tab === 'forms' && nameOnly('Dosage forms', '/dosage-forms')}
        {tab === 'cats' && <ResourcePage cfg={{ title: 'Categories', path: '/categories', columns: [{ key: 'name', header: 'Name' }, { key: 'parent_id', header: 'Parent', render: (r) => <ParentName id={r.parent_id} /> }], create: { permission: 'catalog.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'parentId', label: 'Parent category', type: 'lookup', lookup: { path: '/categories' } }] }, edit: { permission: 'catalog.manage', fields: [{ name: 'name', label: 'Name', required: true }] } }} />}
        {tab === 'mfr' && nameOnly('Manufacturers', '/manufacturers', 'catalog.manage', [{ name: 'country', label: 'Country' }])}
      </div>
    </div>
  );
}
const ParentName = ({ id }: { id?: string | null }) => { const c = useLookup('/categories'); return <>{c.data?.find((x) => x.id === id)?.name ?? '—'}</>; };

// ---------- tax ----------
export function TaxPage() {
  const { can } = useAuth(); const [tab, setTab] = useState('rules'); const qc = useQueryClient(); const toast = useToast();
  const [sup, setSup] = useState<Row | null>(null);
  const cats = useLookup('/tax-categories');
  return (
    <div>
      <PageHeader title="Tax" subtitle="Rates come from here, never from the code. Rates are examples until confirmed with ERCA and your accountant." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: 'Tax rules' }, { id: 'cats', label: 'Tax categories' }]} />
      <div className="mt-3">
        {tab === 'cats' && <ResourcePage cfg={{ title: 'Tax categories', path: '/tax-categories', columns: [{ key: 'name', header: 'Name' }, { key: 'description', header: 'Description' }, { key: 'is_active', header: 'Active', type: 'bool' }], create: { permission: 'tax.manage', fields: [{ name: 'name', label: 'Name', required: true }] }, edit: { permission: 'tax.manage', fields: [{ name: 'name', label: 'Name', required: true }] } }} />}
        {tab === 'rules' && <ResourcePage cfg={{
          title: 'Tax rules', path: '/tax-rules',
          columns: [{ key: 'name', header: 'Rule' }, { key: 'tax_category_id', header: 'Category', render: (r) => <>{cats.data?.find((c) => c.id === r.tax_category_id)?.name ?? '—'}</> }, { key: 'tax_code', header: 'Code' }, { key: 'rate', header: 'Rate %', align: 'right' }, { key: 'is_inclusive', header: 'Price includes tax', type: 'bool' }, { key: 'rounding_rule', header: 'Rounding', type: 'badge' }, { key: 'effective_from', header: 'From', type: 'date' }, { key: 'effective_to', header: 'To', type: 'date' }],
          create: { permission: 'tax.manage', fields: [{ name: 'taxCategoryId', label: 'Tax category', type: 'lookup', lookup: { path: '/tax-categories' }, required: true }, { name: 'taxCode', label: 'Tax code', required: true, placeholder: 'VAT' }, { name: 'name', label: 'Name', required: true }, { name: 'rate', label: 'Rate (%)', type: 'decimal', required: true }, { name: 'isInclusive', label: 'Inclusive', type: 'checkbox', help: 'Shelf prices already include this tax' }, { name: 'roundingRule', label: 'Rounding', type: 'select', default: 'half_up', options: ['half_up', 'half_even', 'down', 'up'].map((v) => ({ value: v, label: label(v) })) }, { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true }, { name: 'effectiveTo', label: 'Effective to', type: 'date' }] },
          edit: { permission: 'tax.manage', fields: [{ name: 'name', label: 'Name' }, { name: 'effectiveTo', label: 'Effective to', type: 'date', help: 'End date. To change the rate, use “New rate” instead.' }] },
          rowActions: (r) => can('tax.manage') && !r.effective_to ? <button className="btn-ghost py-1" onClick={() => setSup(r)}>New rate</button> : null,
        }} />}
      </div>
      {sup && <FormModal title={`New rate for ${sup.name}`} fields={[{ name: 'rate', label: 'New rate (%)', type: 'decimal', required: true }, { name: 'effectiveFrom', label: 'Starts on', type: 'date', required: true, help: 'The old rule ends the day before. Past sales keep their old rate.' }]} onClose={() => setSup(null)}
        onSubmit={async (v) => { await api.post(`/tax-rules/${sup.id}/supersede`, v); toast.ok('Saved'); void qc.invalidateQueries({ queryKey: ['list', '/tax-rules'] }); }} />}
    </div>
  );
}

export const PaymentMethodsPage = () => <ResourcePage cfg={{
  title: 'Payment methods', path: '/payment-methods',
  columns: [{ key: 'sort_order', header: '#', align: 'right' }, { key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'is_cash', header: 'Cash', type: 'bool' }, { key: 'is_credit', header: 'On account', type: 'bool' }, { key: 'requires_reference', header: 'Needs reference', type: 'bool' }, { key: 'is_active', header: 'Active', type: 'bool' }],
  create: { permission: 'settings.manage', fields: [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'isCash', label: 'Cash', type: 'checkbox', help: 'Counts into the till' }, { name: 'requiresReference', label: 'Reference', type: 'checkbox', help: 'Cashier must type a transaction reference' }, { name: 'sortOrder', label: 'Order', type: 'number', default: 100 }] },
  edit: { permission: 'settings.manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'requiresReference', label: 'Reference', type: 'checkbox', help: 'Cashier must type a transaction reference' }, { name: 'isActive', label: 'Active', type: 'checkbox', help: 'Offered at the till' }, { name: 'sortOrder', label: 'Order', type: 'number' }] },
}} />;

// ---------- settings ----------
export function SettingsPage() {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const [branchId, setBranchId] = useState(''); const [search, setSearch] = useState(''); const [edit, setEdit] = useState<Row | null>(null); const [hist, setHist] = useState<Row | null>(null);
  const q = useQuery({ queryKey: ['settings', branchId], queryFn: async () => (await api.list('/settings', { branchId: branchId || undefined })).items });
  const rows = (q.data ?? []).filter((r) => !search || r.key.includes(search.toLowerCase()) || (r.description ?? '').toLowerCase().includes(search.toLowerCase()));
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div>
      <PageHeader title="Settings" subtitle="Every business rule that can differ between clients lives here." />
      <div className="mb-3 flex flex-wrap items-end gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900"><SearchBox value={search} onChange={setSearch} /><div className="min-w-[12rem]"><label className="label">Showing values for</label><BranchSelect value={branchId} onChange={setBranchId} all="Whole business" /></div></div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : groups.map((g) => (
        <div key={g} className="card mb-3 overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800"><div className="border-b border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:border-slate-800 dark:bg-slate-850 dark:text-slate-300">{label(g)}</div>
          <DataTable columns={[{ key: 'key', header: 'Setting', render: (r) => <div><div className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">{r.key}</div><div className="text-xs text-slate-500">{r.description}</div></div> }, { key: 'value', header: 'Value', render: (r) => <code className="text-xs bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded font-mono">{JSON.stringify(r.value)}</code> }, { key: 'source', header: 'From', type: 'badge' },
            { key: '_a', header: '', render: (r) => <div className="flex justify-end gap-1">{can('settings.manage') && <button className="btn-ghost py-1 px-2 text-xs" onClick={() => setEdit(r)}>Change</button>}<button className="btn-ghost py-1 px-2 text-xs" onClick={() => setHist(r)}>History</button></div> }]} rows={rows.filter((r) => r.group === g)} />
        </div>
      ))}
      {edit && <SettingEdit row={edit} branchId={branchId} onClose={() => setEdit(null)} onDone={() => { toast.ok('Saved'); void qc.invalidateQueries({ queryKey: ['settings'] }); setEdit(null); }} />}
      {hist && <SettingHistory row={hist} onClose={() => setHist(null)} />}
    </div>
  );
}
function SettingEdit({ row, branchId, onClose, onDone }: { row: Row; branchId: string; onClose(): void; onDone(): void }) {
  const [text, setText] = useState(JSON.stringify(row.value)); const [reason, setReason] = useState('');
  const toast = useToast(); let parsed: unknown; let bad = false; try { parsed = JSON.parse(text); } catch { bad = true; }
  const isBool = typeof row.value === 'boolean';
  return (
    <Modal title={row.key} onClose={onClose} footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button>
      <ActionButton className="btn-primary" disabled={bad} run={async () => { try { await api.put(`/settings/${row.key}`, { value: parsed, ...(branchId && row.branchOverridable ? { branchId } : {}), ...(row.version ? { version: row.version } : {}), ...(reason ? { reason } : {}) }); onDone(); } catch (e) { toast.error(e); throw e; } }}>Save</ActionButton></>}>
      <p className="mb-2 text-sm text-slate-500">{row.description}</p>
      {branchId && !row.branchOverridable && <p className="mb-2 text-sm text-amber-700">This setting applies to the whole business and cannot be set per branch.</p>}
      {isBool ? <select className="input" value={text} onChange={(e) => setText(e.target.value)}><option value="true">Yes</option><option value="false">No</option></select> : <textarea className="input font-mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} />}
      {bad && <p className="text-xs text-red-600">Text values need quotes, e.g. "ETB". Numbers do not.</p>}
      <label className="label mt-3">Reason (kept in the history)</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}
function SettingHistory({ row, onClose }: { row: Row; onClose(): void }) {
  const q = useQuery({ queryKey: ['setting-hist', row.key], queryFn: async () => (await api.list(`/settings/${row.key}/history`)).items });
  return <Modal title={`History · ${row.key}`} onClose={onClose}>{q.isLoading ? <Spinner /> : q.data?.length ? <AutoTable rows={q.data} /> : <Empty text="Never changed from the default." />}</Modal>;
}

export function NumberingPage() {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast(); const [edit, setEdit] = useState<Row | null>(null);
  const q = useQuery({ queryKey: ['sequences'], queryFn: async () => (await api.list('/document-sequences')).items });
  const fields: FieldDef[] = [{ name: 'prefix', label: 'Prefix', help: 'Letters before the number, e.g. INV' }, { name: 'padding', label: 'Digits', type: 'number', required: true, min: 1, max: 12 }, { name: 'resetRule', label: 'Restart numbering', type: 'select', required: true, options: [{ value: 'never', label: 'Never' }, { value: 'yearly', label: 'Every year' }] }, { name: 'nextValue', label: 'Next number', type: 'number', min: 1, help: 'Only raise this; going back could repeat a number.' }];
  return (
    <div>
      <PageHeader title="Document numbering" subtitle="How receipts, orders and other documents are numbered." />
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <DataTable columns={[{ key: 'doc_type', header: 'Document', render: (r) => label(r.doc_type) }, { key: 'prefix', header: 'Prefix' }, { key: 'padding', header: 'Digits', align: 'right' }, { key: 'reset_rule', header: 'Restarts', render: (r) => label(r.reset_rule) }, { key: 'next_value', header: 'Next', align: 'right' }, { key: '_', header: '', render: (r) => can('settings.manage') && <button className="btn-ghost py-1 px-2 text-xs" onClick={() => setEdit(r)}>Change</button> }]} rows={q.data ?? []} />}</div>
      {edit && <FormModal title={`Numbering · ${label(edit.doc_type)}`} fields={fields} row={{ prefix: edit.prefix, padding: edit.padding, resetRule: edit.reset_rule, nextValue: edit.next_value }} onClose={() => setEdit(null)} onSubmit={async (v) => { await api.put(`/document-sequences/${edit.doc_type}`, { prefix: v.prefix ?? '', padding: Number(v.padding), resetRule: v.resetRule, ...(v.nextValue ? { nextValue: Number(v.nextValue) } : {}) }); toast.ok('Saved'); void qc.invalidateQueries({ queryKey: ['sequences'] }); }} />}
    </div>
  );
}

// ---------- tablets & conflicts ----------
export function DevicesPage() {
  return <ResourcePage cfg={{
    title: 'Tablets', subtitle: 'Devices registered for offline selling. Revoke a lost tablet.', path: '/sync/devices',
    columns: [{ key: 'name', header: 'Name' }, { key: 'register_id', header: 'Register' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'last_seen_at', header: 'Last seen', type: 'datetime' }, { key: 'last_sync_at', header: 'Last sync', type: 'datetime' }],
    rowActions: (r, reload) => r.status === 'active' ? <ActionButton className="btn-ghost py-1" confirm="Revoke this tablet? It will no longer be able to sync. Sales still on it are lost unless uploaded first." run={async () => { await api.post(`/sync/devices/${r.id}/revoke`); reload(); }}>Revoke</ActionButton> : null,
  }} />;
}
export function ConflictsPage() {
  const toast = useToast();
  return <ResourcePage cfg={{
    title: 'Offline sale problems', subtitle: 'Sales made offline that could not be accepted. Retry after fixing the cause (for example stock), or dismiss with a note.', path: '/sync/conflicts',
    filters: [{ name: 'status', label: 'Status', type: 'select', options: ['open', 'resolved', 'dismissed'].map((v) => ({ value: v, label: label(v) })), default: 'open' }],
    columns: [{ key: 'offline_ref', header: 'Offline ref' }, { key: 'device_name', header: 'Tablet' }, { key: 'code', header: 'Problem', type: 'badge' }, { key: 'message', header: 'Detail' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'When', type: 'datetime' }],
    rowActions: (r, reload) => r.status === 'open' ? <>
      <ActionButton className="btn-ghost py-1" run={async () => { await api.post(`/sync/conflicts/${r.id}/retry`); toast.ok('Retried'); reload(); }}>Retry</ActionButton>
      <ActionButton className="btn-ghost py-1" confirm="Dismiss this sale? It will not be recorded." run={async () => { await api.post(`/sync/conflicts/${r.id}/dismiss`, {}); reload(); }}>Dismiss</ActionButton></> : null,
  }} />;
}

export function JobsPage() {
  const { can } = useAuth(); const q = useQuery({ queryKey: ['jobs'], queryFn: async () => (await api.list('/jobs')).items }); const qc = useQueryClient(); const toast = useToast();
  return (
    <div><PageHeader title="Background jobs" subtitle="Scheduled housekeeping such as stock alerts and expiry sweeps." />
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <DataTable columns={[{ key: 'name', header: 'Job' }, { key: 'description', header: 'What it does' }, { key: 'everyMinutes', header: 'Every (min)', align: 'right' }, { key: 'last', header: 'Last run', render: (r) => r.lastRun ? <span><Badge value={r.lastRun.status} /> {dateTime(r.lastRun.started_at)}</span> : '—' },
        { key: '_', header: '', render: (r) => can('jobs.run') && <ActionButton className="btn-ghost py-1 px-2 text-xs" run={async () => { await api.post(`/jobs/${r.name}/run`); toast.ok('Done'); void qc.invalidateQueries({ queryKey: ['jobs'] }); }}>Run now</ActionButton> }]} rows={q.data ?? []} />}</div>
    </div>
  );
}

export function AuditPage() {
  const [f, setF] = useState<Row>({}); const d = useDebounced(f);
  const list = usePagedList('/audit-logs', Object.fromEntries(Object.entries(d).filter(([, v]) => v)) as Record<string, string>, 50);
  const flds: FieldDef[] = [{ name: 'action', label: 'Action contains' }, { name: 'entityType', label: 'Record type' }, { name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }];
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <div><PageHeader title="Audit log" subtitle="Who did what, and when. Entries cannot be edited." />
      <div className="mb-3 grid gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900"><FormFields idPrefix="flt" fields={flds} values={f} setValues={setF} /></div>
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : <><DataTable onRowClick={setOpen} columns={[{ key: 'occurred_at', header: 'When', type: 'datetime' }, { key: 'username', header: 'User' }, { key: 'action', header: 'Action' }, { key: 'entity_type', header: 'Record' }, { key: 'ip_address', header: 'IP' }]} rows={list.rows} /><Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} /></>}</div>
      {open && <Modal title={open.action} onClose={() => setOpen(null)}><KeyValues data={open} /></Modal>}
    </div>
  );
}
