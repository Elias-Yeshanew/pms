import { AppError } from './app-error';
import { Queryable } from '../database/database.service';

/**
 * UPDATE with optimistic concurrency. Column names come only from calling code (never from request
 * input); values are always bound parameters. Throws 404 when the row is missing and 409 when
 * someone else changed it since the caller read it.
 */
export async function updateVersioned<R = any>(
  q: Queryable,
  table: string,
  id: string,
  version: number,
  fields: Record<string, unknown>,
  actorId: string | null,
  notFound: () => AppError,
): Promise<R> {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`);
  const res = await q.query(
    `update ${table} set ${sets.length ? sets.join(', ') + ',' : ''} version = version + 1, updated_by = $3
      where id = $1 and version = $2 returning *`,
    [id, version, actorId, ...keys.map((k) => fields[k])],
  );
  if (res.rows[0]) return res.rows[0] as R;
  const exists = await q.query(`select 1 from ${table} where id = $1`, [id]);
  if (!exists.rows.length) throw notFound();
  throw AppError.conflict('VERSION_CONFLICT', 'The record was changed by someone else. Reload it and try again.');
}
