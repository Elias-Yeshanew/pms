import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, many, maybeOne, one, Queryable } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

/** Every kind of numbered document, with its default prefix. Later modules add theirs here. */
export const DOC_TYPES = {
  product_sku: 'PRD', barcode: '', price_update: 'PUP', supplier: 'SUP', customer: 'CUS', prescription: 'RX',
  purchase_request: 'PR', purchase_order: 'PO', goods_receipt: 'GRN', supplier_invoice: 'SINV', supplier_payment: 'SPAY', purchase_return: 'PRT',
  sale: 'S', sale_cancel: 'SCN', discount_request: 'DSC', sales_return: 'SR', customer_payment: 'CPAY',
  stock_adjustment: 'ADJ', stock_status: 'STS', stock_count: 'CNT', stock_transfer: 'TRF', disposal: 'DSP',
  expense: 'EXP', income: 'INC', journal_entry: 'JE', daily_closing: 'DC',
} as const;
export type DocType = keyof typeof DOC_TYPES;
export const isDocType = (t: string): t is DocType => Object.prototype.hasOwnProperty.call(DOC_TYPES, t);

interface SeqRow { id: string; doc_type: string; branch_id: string | null; prefix: string; padding: number; reset_rule: 'never' | 'yearly'; next_value: string; last_reset_year: number | null }

export function formatReference(prefix: string, padding: number, resetRule: 'never' | 'yearly', year: number, value: bigint): string {
  const parts = [prefix, resetRule === 'yearly' ? String(year) : '', value.toString().padStart(padding, '0')].filter((p) => p !== '');
  return parts.join('-');
}

@Injectable()
export class SequenceService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  /**
   * Returns the next reference number. Pass the caller's transaction: the number is taken under a row lock
   * and only becomes permanent if that transaction commits, so a rolled-back document does not leave a gap.
   * A branch-specific sequence is preferred over the company-wide one.
   */
  async next(q: Queryable, docType: DocType, branchId: string | null = null, now: Date = new Date()): Promise<string> {
    const pick = () => maybeOne<SeqRow>(
      q,
      `select * from platform.document_sequences where doc_type = $1 and (branch_id = $2 or branch_id is null)
        order by branch_id nulls last limit 1 for update`,
      [docType, branchId],
    );
    let seq = await pick();
    if (!seq) {
      await q.query(`insert into platform.document_sequences (doc_type, prefix, padding) values ($1, $2, $3) on conflict do nothing`, [docType, DOC_TYPES[docType], docType === 'barcode' ? 11 : 6]);
      seq = await pick();
    }
    if (!seq) throw new Error(`Could not obtain a sequence for ${docType}`);

    const year = now.getUTCFullYear();
    let value = BigInt(seq.next_value);
    if (seq.reset_rule === 'yearly' && seq.last_reset_year !== year) value = 1n;
    await q.query(`update platform.document_sequences set next_value = $2, last_reset_year = $3 where id = $1`, [seq.id, (value + 1n).toString(), seq.reset_rule === 'yearly' ? year : seq.last_reset_year]);
    return formatReference(seq.prefix, seq.padding, seq.reset_rule, year, value);
  }

  async list() {
    const rows = await many<SeqRow>(this.db, `select * from platform.document_sequences order by doc_type, branch_id nulls first`);
    const have = new Set(rows.filter((r) => !r.branch_id).map((r) => r.doc_type));
    const virtual = (Object.keys(DOC_TYPES) as DocType[]).filter((t) => !have.has(t)).map((t) => ({
      id: null, doc_type: t, branch_id: null, prefix: DOC_TYPES[t], padding: t === 'barcode' ? 11 : 6, reset_rule: 'never', next_value: '1', last_reset_year: null,
    }));
    return [...rows, ...virtual].sort((a, b) => a.doc_type.localeCompare(b.doc_type));
  }

  async configure(auth: AuthContext, rawType: string, dto: { branchId?: string | null; prefix: string; padding: number; resetRule: 'never' | 'yearly'; nextValue?: number }) {
    if (!isDocType(rawType)) throw AppError.notFound('DOC_TYPE_NOT_FOUND', 'Unknown document type.');
    const branchId = dto.branchId ?? null;
    const scope = auth.scopeFor('settings.manage');
    if (branchId ? !scope.includes(branchId) : !scope.isUnrestricted) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot change numbering for this scope.');

    await this.db.tx(async (q) => {
      const cur = await maybeOne<SeqRow>(q, `select * from platform.document_sequences where doc_type = $1 and branch_id is not distinct from $2 for update`, [rawType, branchId]);
      const requested = dto.nextValue !== undefined ? BigInt(dto.nextValue) : undefined;
      // Lowering the counter could repeat numbers that already exist
      if (cur && requested !== undefined && requested < BigInt(cur.next_value)) throw AppError.badRequest('SEQUENCE_CANNOT_GO_BACK', 'The next number cannot be lower than the current one.');
      const next = requested ?? (cur ? BigInt(cur.next_value) : 1n);
      if (cur) {
        await q.query(`update platform.document_sequences set prefix = $2, padding = $3, reset_rule = $4, next_value = $5, updated_by = $6 where id = $1`, [cur.id, dto.prefix, dto.padding, dto.resetRule, next.toString(), auth.userId]);
      } else {
        await q.query(`insert into platform.document_sequences (doc_type, branch_id, prefix, padding, reset_rule, next_value, updated_by) values ($1, $2, $3, $4, $5, $6, $7)`, [rawType, branchId, dto.prefix, dto.padding, dto.resetRule, next.toString(), auth.userId]);
      }
      await this.audit.record({ action: 'sequence.configured', entityType: 'document_sequence', entityId: rawType, branchId, oldValue: cur ? { prefix: cur.prefix, padding: cur.padding, resetRule: cur.reset_rule, nextValue: cur.next_value } : null, newValue: { ...dto, nextValue: next.toString() } }, q);
    });
    return (await this.list()).filter((s) => s.doc_type === rawType);
  }
}

export { one };
