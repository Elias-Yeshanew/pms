import { ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { label } from '../lib/format';
import {
  ActionButton, AutoTable, Column, DataTable, ErrorBox, FieldDef, FormFields, FormModal, KeyValues, Modal, PageHeader, Pager, Spinner, cleanValues, initialValues, usePagedList, useToast, FormFields as FF,
} from './kit';
import { Line, LinesEditor, LineField } from './lines';

export interface DocAction {
  label: string; path(doc: Row): string; method?: 'post' | 'put' | 'patch' | 'del'; permission?: string; show?(doc: Row): boolean;
  fields?: FieldDef[]; body?(values: Row, doc: Row): Row; confirm?: string; danger?: boolean; success?: string;
}
export interface DocCfg {
  title: string; subtitle?: string; path: string; columns: Column[]; readPermission?: string;
  statuses?: string[]; filters?: FieldDef[];
  create?: {
    permission: string; title?: string; label?: string; header: FieldDef[];
    lines?: { fields: LineField[]; purchasable?: boolean; sellable?: boolean; label?: string; unitField?: boolean; min?: number };
    build(values: Row, lines: Line[]): Row;
    note?: string;
  };
  /** a creation form that needs its own screen (e.g. receiving against an order) */
  customCreate?: { permission: string; label?: string; render(close: () => void, done: (r?: Row) => void): ReactNode };
  actions?: DocAction[];
  extra?(doc: Row, reload: () => void): ReactNode;
  pageSize?: number;
}

export function DocumentPage({ cfg }: { cfg: DocCfg }) {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState(''); const [filters, setFilters] = useState<Row>(() => initialValues(cfg.filters ?? []));
  const [creating, setCreating] = useState(false); const [openId, setOpenId] = useState<string | null>(null);
  const query = { status: status || undefined, ...cleanValues(cfg.filters ?? [], filters) } as Record<string, string | undefined>;
  const list = usePagedList(cfg.path, query, cfg.pageSize ?? 25);
  const reload = () => { void qc.invalidateQueries({ queryKey: ['list', cfg.path] }); void qc.invalidateQueries({ queryKey: ['doc', cfg.path] }); };
  return (
    <div>
      <PageHeader
        title={cfg.title}
        subtitle={cfg.subtitle}
        actions={
          (cfg.create && can(cfg.create.permission) && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              {cfg.create.label ?? 'New'}
            </button>
          )) ||
          (cfg.customCreate && can(cfg.customCreate.permission) && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              {cfg.customCreate.label ?? 'New'}
            </button>
          ))
        }
      />
      {(cfg.statuses || cfg.filters?.length) && (
        <div className="mb-3 flex flex-wrap items-end gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          {cfg.statuses && (
            <div className="min-w-[10rem]">
              <label className="label">Status</label>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {cfg.statuses.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {cfg.filters?.map((f) => (
            <div key={f.name} className="min-w-[10rem]">
              <FormFields idPrefix="flt" fields={[{ ...f, required: false }]} values={filters} setValues={setFilters} />
            </div>
          ))}
        </div>
      )}
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <ErrorBox error={list.error} />
          </div>
        ) : (
          <>
            <DataTable columns={cfg.columns} rows={list.rows} onRowClick={(r) => setOpenId(r.id)} />
            <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
          </>
        )}
      </div>
      {creating && cfg.customCreate && cfg.customCreate.render(() => setCreating(false), (r) => { toast.ok('Saved'); reload(); setCreating(false); if (r?.id) setOpenId(r.id); })}
      {creating && cfg.create && <CreateDoc cfg={cfg} onClose={() => setCreating(false)} onDone={(r) => { toast.ok('Saved'); reload(); setCreating(false); if (r?.id) setOpenId(r.id); }} />}
      {openId && <DocDetail cfg={cfg} id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}

function CreateDoc({ cfg, onClose, onDone }: { cfg: DocCfg; onClose(): void; onDone(r: Row): void }) {
  const c = cfg.create!;
  const [values, setValues] = useState<Row>(() => initialValues(c.header));
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (c.lines && lines.length < (c.lines.min ?? 1)) { setError(new Error('Add at least one item.')); return; }
    setBusy(true);
    try { onDone(await api.post(cfg.path, c.build(cleanValues(c.header, values), lines))); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={c.title ?? `New ${cfg.title.toLowerCase()}`} onClose={onClose} wide={!!c.lines}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <ErrorBox error={error} /> : null}
        {c.note && <p className="rounded border border-sky-200 bg-sky-50/80 p-2.5 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200">{c.note}</p>}
        <FF fields={c.header} values={values} setValues={setValues} />
        {c.lines && <LinesEditor lines={lines} setLines={setLines} fields={c.lines.fields} purchasable={c.lines.purchasable} sellable={c.lines.sellable} label={c.lines.label} unitField={c.lines.unitField} />}
        <div className="flex justify-end gap-2.5 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DocDetail({ cfg, id, onClose, onChanged }: { cfg: DocCfg; id: string; onClose(): void; onChanged(): void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['doc', cfg.path, id], queryFn: () => api.get<Row>(`${cfg.path}/${id}`) });
  const [action, setAction] = useState<DocAction | null>(null);
  const d = q.data;
  const reload = () => { void q.refetch(); onChanged(); };
  const lists = d ? Object.entries(d).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object') : [];
  return (
    <Modal title={d ? String(d.reference_no ?? d.name ?? cfg.title) : cfg.title} onClose={onClose} wide>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : d && (
        <div className="space-y-4">
          <KeyValues data={d} />
          {lists.map(([k, rows]) => (
            <div key={k} className="mt-3">
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label(k)}</h3>
              <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-800">
                <AutoTable rows={rows as Row[]} />
              </div>
            </div>
          ))}
          {cfg.extra?.(d, reload)}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            {cfg.actions?.filter((a) => (!a.permission || can(a.permission)) && (!a.show || a.show(d))).map((a) => a.fields ? (
              <button key={a.label} className={a.danger ? 'btn-danger' : 'btn-ghost'} onClick={() => setAction(a)}>{a.label}</button>
            ) : (
              <ActionButton key={a.label} className={a.danger ? 'btn-danger' : 'btn-ghost'} confirm={a.confirm} success={a.success ?? 'Done'} run={async () => { await call(a, d, {}); reload(); }}>{a.label}</ActionButton>
            ))}
          </div>
        </div>
      )}
      {action && d && <FormModal title={action.label} fields={action.fields!} onClose={() => setAction(null)} onSubmit={async (v) => { await call(action, d, v); reload(); }} />}
    </Modal>
  );
}
async function call(a: DocAction, d: Row, v: Row) {
  const body = a.body ? a.body(v, d) : v;
  const m = a.method ?? 'post';
  if (m === 'del') return api.del(a.path(d));
  return (api as any)[m](a.path(d), body);
}
