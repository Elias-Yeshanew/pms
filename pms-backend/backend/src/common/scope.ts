/**
 * Branch scope of a permission: which branches the user may use it in.
 *  - all=true, except empty  -> every branch (and records not tied to a branch)
 *  - all=true, except set    -> every branch except those listed
 *  - all=false               -> only the listed branches
 */
export class Scope {
  constructor(
    readonly all: boolean,
    readonly ids: ReadonlySet<string> = new Set(),
    readonly except: ReadonlySet<string> = new Set(),
  ) {}

  static none() { return new Scope(false); }
  static everything() { return new Scope(true); }

  get isEmpty(): boolean { return !this.all && this.ids.size === 0; }
  /** True only for unrestricted company-wide access. */
  get isUnrestricted(): boolean { return this.all && this.except.size === 0; }

  /** branchId null means the record is not tied to a branch (company-level). */
  includes(branchId: string | null | undefined): boolean {
    if (branchId == null) return this.isUnrestricted;
    return this.all ? !this.except.has(branchId) : this.ids.has(branchId);
  }

  /**
   * Builds a SQL condition for a branch column and appends its parameters.
   * Always applied on the backend so list queries can never leak other branches.
   */
  sql(column: string, params: unknown[]): string {
    if (this.isUnrestricted) return 'true';
    if (this.isEmpty) return 'false';
    if (this.all) {
      params.push([...this.except]);
      return `(${column} is not null and ${column} <> all($${params.length}::uuid[]))`;
    }
    params.push([...this.ids]);
    return `${column} = any($${params.length}::uuid[])`;
  }
}
