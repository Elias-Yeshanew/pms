import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';

// A calendar date has no time zone. Return it as 'YYYY-MM-DD' text instead of a Date that shifts with the server's clock.
types.setTypeParser(1082, (value: string) => value);
import { ENV, Env } from '../config/env';

/** Anything that can run a query: the pool or a transaction client. */
export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy, Queryable {
  readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX, connectionTimeoutMillis: 15_000 });
  }

  query<R extends QueryResultRow = any>(text: string, values?: any[]) {
    return this.pool.query<R>(text, values);
  }

  /**
   * Runs fn inside one transaction; commits on success, rolls back on any error.
   * A deadlock or serialization failure rolls everything back and runs fn again (up to 3 times in total),
   * so fn must only touch the database through the client it is given.
   */
  async tx<T>(fn: (q: PoolClient) => Promise<T>, isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection already broken; the original error matters more */
        }
        const code = (err as { code?: string })?.code;
        if ((code === '40P01' || code === '40001') && attempt < 3) continue;
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export async function one<R extends QueryResultRow = any>(q: Queryable, text: string, values?: any[]): Promise<R> {
  const res = await q.query<R>(text, values);
  if (res.rows.length !== 1) throw new Error(`Expected exactly one row, got ${res.rows.length}`);
  return res.rows[0];
}

export async function maybeOne<R extends QueryResultRow = any>(q: Queryable, text: string, values?: any[]): Promise<R | null> {
  const res = await q.query<R>(text, values);
  return res.rows[0] ?? null;
}

export async function many<R extends QueryResultRow = any>(q: Queryable, text: string, values?: any[]): Promise<R[]> {
  return (await q.query<R>(text, values)).rows;
}
