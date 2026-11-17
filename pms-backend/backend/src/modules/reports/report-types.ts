import { AuthContext } from '../../common/auth-types';
import { DatabaseService } from '../../database/database.service';

export type ColType = 'text' | 'money' | 'qty' | 'percent' | 'int' | 'date';
export interface Col { key: string; label: string; type: ColType; /** summed into the totals row */ sum?: boolean; /** only for people who may see costs */ cost?: boolean }
export type Row = Record<string, string | number | null>;

/** Builds numbered SQL parameters. $1 = from, $2 = to, $3 = time zone are always in place. */
export class Params {
  readonly values: unknown[];
  constructor(from: string, to: string, tz: string) { this.values = [from, to, tz]; }
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
  /** A condition that is always true but mentions $1-$3, because Postgres rejects parameters a statement never uses */
  keep(): string { return '($1::date is not null and $2::date is not null and $3::text is not null)'; }
  /** Whole shop days from `from` to `to`, both included, in the shop's time zone */
  range(col: string): string { return `${col} >= ($1::date)::timestamp at time zone $3 and ${col} < (($2::date) + 1)::timestamp at time zone $3`; }
}

export interface ReportCtx {
  db: DatabaseService; auth: AuthContext; from: string; to: string; tz: string; today: string; days: number;
  branchId?: string; limit: number; canCost: boolean; options: Record<string, string | undefined>;
}
export interface ReportDef {
  code: string; title: string; description: string; group: 'sales' | 'inventory' | 'procurement' | 'management';
  permission: string; /** does the date range apply? */ ranged: boolean; columns: Col[];
  run(c: ReportCtx): Promise<Row[]>;
}
