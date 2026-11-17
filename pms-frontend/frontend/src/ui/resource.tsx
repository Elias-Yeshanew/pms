import { ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  ActionButton, Column, DataTable, ErrorBox, FieldDef, FormModal, KeyValues, Modal, PageHeader, Pager, SearchBox, Spinner, useDebounced, usePagedList, useToast, AutoTable, Empty, FormFields, initialValues, cleanValues,
} from './kit';

export interface ResourceCfg {
  title: string; subtitle?: string; path: string; columns: Column[];
  readPermission?: string;
  searchable?: boolean; filters?: FieldDef[]; staticQuery?: Record<string, string>;
  create?: { permission: string; fields: FieldDef[]; title?: string; transform?(v: Row): Row; label?: string };
  edit?: { permission: string; fields: FieldDef[]; transform?(v: Row): Row; path?(row: Row): string };
  rowActions?(row: Row, reload: () => void): ReactNode;
  header?: ReactNode;
  pageSize?: number;
  /** show detail modal when a row is clicked (default true when no edit) */
  detail?: boolean;
}

/** One list screen with search, filters, add and edit. Most reference-data screens are just a config for this. */
export function ResourcePage({ cfg }: { cfg: ResourceCfg }) {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const [search, setSearch] = useState(''); const s = useDebounced(search);
  const [filters, setFilters] = useState<Row>(() => initialValues(cfg.filters ?? []));
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; row?: Row } | null>(null);
  const [view, setView] = useState<Row | null>(null);
  const query = { ...cfg.staticQuery, ...cleanValues(cfg.filters ?? [], filters), search: cfg.searchable ? s || undefined : undefined } as Record<string, string | number | undefined>;
  const list = usePagedList(cfg.path, query, cfg.pageSize ?? 25);
  const reload = () => { void qc.invalidateQueries({ queryKey: ['list', cfg.path] }); void qc.invalidateQueries({ queryKey: ['lookup'] }); };
  const canCreate = cfg.create && can(cfg.create.permission);
  const canEdit = cfg.edit && can(cfg.edit.permission);
  const cols: Column[] = [...cfg.columns];
  if (cfg.rowActions || canEdit) {
    cols.push({
      key: '_actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {canEdit && <button className="btn-ghost py-1 px-2.5 text-xs font-semibold" onClick={() => setForm({ mode: 'edit', row: r })}>Edit</button>}
          {cfg.rowActions?.(r, reload)}
        </div>
      ),
    });
  }
  return (
    <div>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} actions={<>{cfg.header}{canCreate && <button className="btn-primary" onClick={() => setForm({ mode: 'create' })}>{cfg.create!.label ?? 'Add'}</button>}</>} />
      {(cfg.searchable || cfg.filters?.length) && (
        <div className="mb-3 flex flex-wrap items-end gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {cfg.searchable && <SearchBox value={search} onChange={setSearch} />}
          {cfg.filters && <div className="flex flex-wrap items-end gap-2.5">{cfg.filters.map((f) => <div key={f.name} className="min-w-[10rem]"><FormFields idPrefix="flt" fields={[{ ...f, required: false }]} values={filters} setValues={setFilters} /></div>)}</div>}
        </div>
      )}
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : (
          <>
            <DataTable columns={cols} rows={list.rows} onRowClick={cfg.detail === false ? undefined : (r) => setView(r)} />
            <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
          </>
        )}
      </div>
      {form?.mode === 'create' && cfg.create && (
        <FormModal title={cfg.create.title ?? `Add ${cfg.title.toLowerCase()}`} fields={cfg.create.fields} onClose={() => setForm(null)}
          onSubmit={async (v) => { await api.post(cfg.path, cfg.create!.transform ? cfg.create!.transform(v) : v); toast.ok('Saved'); reload(); }} />
      )}
      {form?.mode === 'edit' && cfg.edit && form.row && (
        <FormModal title={`Edit ${cfg.title.toLowerCase()}`} fields={cfg.edit.fields} row={form.row} onClose={() => setForm(null)}
          onSubmit={async (v) => { const body = cfg.edit!.transform ? cfg.edit!.transform(v) : v; await api.patch(cfg.edit!.path ? cfg.edit!.path(form.row!) : `${cfg.path}/${form.row!.id}`, { version: form.row!.version, ...body }); toast.ok('Saved'); reload(); }} />
      )}
      {view && <Modal title={String(view.name ?? view.reference_no ?? view.username ?? view.code ?? 'Details')} onClose={() => setView(null)}><KeyValues data={view} /></Modal>}
    </div>
  );
}

/** Small reusable "load one thing and show it" helper. */
export function useOne<T = Row>(path: string | null, key?: unknown[]) {
  return useQuery({ queryKey: key ?? ['one', path], enabled: !!path, queryFn: () => api.get<T>(path!) });
}
export { AutoTable, ActionButton, Empty };
