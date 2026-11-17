import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { likePattern, offsetOf, Page, PageQuery } from '../../common/pagination';
import { ENV, Env } from '../../config/env';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { cmp, format, parse, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';

const notFound = () => AppError.notFound('PRESCRIPTION_NOT_FOUND', 'Prescription not found.');
const MAX_ATTACHMENT = 5 * 1024 * 1024;
export interface PrescriptionView { id: string; branch_id: string; status: string; has_attachment: boolean; items: unknown[]; dispensing: unknown[]; [key: string]: unknown }

export interface PrescriptionInput {
  branchId: string; customerId?: string; patientName: string; patientBirthDate?: string; patientPhone?: string; prescriberName: string; prescriberLicenseNo?: string;
  facility?: string; prescribedDate: string; notes?: string; items: Array<{ productId: string; unitId?: string; quantity: string; dosage?: string; frequency?: string; duration?: string; notes?: string }>;
}

/** Decides a scan's real type from its first bytes: PDF, PNG, JPEG or WebP. */
export function sniffDocument(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/**
 * Prescriptions hold personal health information, so every view is logged and reading needs its own permission.
 * The system records what was prescribed and dispensed; it never decides what is clinically appropriate.
 */
@Injectable()
export class PrescriptionsService {
  private readonly root: string;
  constructor(
    private readonly db: DatabaseService, private readonly inventory: InventoryService, private readonly sequences: SequenceService,
    private readonly settings: SettingsService, private readonly audit: AuditService, @Inject(ENV) env: Env,
  ) { this.root = resolve(env.UPLOAD_DIR, 'prescriptions'); }

  async create(auth: AuthContext, dto: PrescriptionInput) {
    if (!auth.scopeFor('prescriptions.manage').includes(dto.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot register prescriptions for this branch.');
    const required = await this.settings.get('prescriptions.required_fields');
    const present: Record<string, unknown> = { patientName: dto.patientName?.trim(), patientBirthDate: dto.patientBirthDate, patientPhone: dto.patientPhone?.trim(), prescriberName: dto.prescriberName?.trim(), prescriberLicenseNo: dto.prescriberLicenseNo?.trim(), facility: dto.facility?.trim(), prescribedDate: dto.prescribedDate };
    const missing = required.filter((f) => !present[f]);
    if (missing.length) throw AppError.badRequest('REQUIRED_FIELDS_MISSING', 'Some details required for a prescription are missing.', { missing });
    const today = await this.settings.businessDate();
    if (dto.prescribedDate > today) throw AppError.badRequest('PRESCRIBED_DATE_IN_FUTURE', 'The prescription date cannot be in the future.');
    const id = await this.db.tx(async (q) => {
      if (!(await maybeOne(q, `select 1 from org.branches where id = $1`, [dto.branchId]))) throw AppError.badRequest('BRANCH_NOT_FOUND', 'The branch does not exist.');
      if (dto.customerId && !(await maybeOne(q, `select 1 from sales.customers where id = $1`, [dto.customerId]))) throw AppError.badRequest('CUSTOMER_NOT_FOUND', 'The customer does not exist.');
      const seen = new Set<string>();
      const items: Array<{ productId: string; base: string; item: PrescriptionInput['items'][number] }> = [];
      for (const it of dto.items) {
        if (seen.has(it.productId)) throw AppError.badRequest('DUPLICATE_LINE', 'The same medicine appears twice on the prescription.');
        seen.add(it.productId);
        if (!(await maybeOne(q, `select 1 from catalog.products where id = $1`, [it.productId]))) throw AppError.badRequest('PRODUCT_NOT_FOUND', 'A medicine does not exist in the catalog.');
        const base = await this.inventory.toBase(q, it.productId, it.unitId, it.quantity);
        if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        items.push({ productId: it.productId, base, item: it });
      }
      const reference = await this.sequences.next(q, 'prescription', dto.branchId);
      const r = await one<{ id: string }>(q, `insert into sales.prescriptions (reference_no, branch_id, customer_id, patient_name, patient_birth_date, patient_phone, prescriber_name, prescriber_license_no, facility, prescribed_date, notes, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [reference, dto.branchId, dto.customerId ?? null, dto.patientName.trim(), dto.patientBirthDate ?? null, dto.patientPhone ?? null, dto.prescriberName.trim(), dto.prescriberLicenseNo ?? null, dto.facility ?? null, dto.prescribedDate, dto.notes ?? null, auth.userId]);
      for (const i of items) await q.query(`insert into sales.prescription_items (prescription_id, product_id, dosage, frequency, duration, quantity_prescribed, notes) values ($1, $2, $3, $4, $5, $6, $7)`, [r.id, i.productId, i.item.dosage ?? null, i.item.frequency ?? null, i.item.duration ?? null, i.base, i.item.notes ?? null]);
      await this.audit.record({ action: 'prescription.registered', entityType: 'prescription', entityId: r.id, branchId: dto.branchId, newValue: { reference, lines: items.length } }, q); // personal details are not copied into the audit log
      return r.id;
    });
    return this.load(auth, id, false);
  }

  private async load(auth: AuthContext, id: string, logView: boolean): Promise<PrescriptionView> {
    const r = await maybeOne<{ id: string; branch_id: string; status: string; attachment_path: string | null } & Record<string, unknown>>(this.db, `select p.*, cu.username as created_by_name, vu.username as validated_by_name from sales.prescriptions p join iam.users cu on cu.id = p.created_by left join iam.users vu on vu.id = p.validated_by where p.id = $1`, [id]);
    if (!r || !auth.scopeFor('prescriptions.read').includes(r.branch_id)) throw notFound();
    const items = await many(this.db, `select i.id, i.product_id, pr.sku, pr.name as product_name, i.dosage, i.frequency, i.duration, i.quantity_prescribed, i.quantity_dispensed, (i.quantity_prescribed - i.quantity_dispensed)::numeric(18,4) as quantity_remaining, i.notes
        from sales.prescription_items i join catalog.products pr on pr.id = i.product_id where i.prescription_id = $1 order by pr.name`, [id]);
    const dispensing = await many(this.db, `select s.id as sale_id, s.reference_no, s.sold_at, s.status, b.code as branch_code from sales.sales s join org.branches b on b.id = s.branch_id where s.prescription_id = $1 order by s.sold_at`, [id]);
    if (logView) await this.audit.record({ action: 'prescription.viewed', entityType: 'prescription', entityId: id, branchId: r.branch_id });
    const { attachment_path, ...rest } = r;
    return { ...rest, has_attachment: !!attachment_path, items, dispensing } as PrescriptionView;
  }

  get(auth: AuthContext, id: string) { return this.load(auth, id, true); }

  async list(auth: AuthContext, q: PageQuery & { status?: string; customerId?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('prescriptions.read').sql('p.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.status) add2('p.status = ?', q.status);
    if (q.customerId) add2('p.customer_id = ?', q.customerId);
    if (q.branchId) add2('p.branch_id = ?', q.branchId);
    if (q.search) { params.push(likePattern(q.search)); where.push(`(p.patient_name ilike $${params.length} or p.reference_no ilike $${params.length} or p.prescriber_name ilike $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from sales.prescriptions p where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select p.id, p.reference_no, p.branch_id, p.patient_name, p.prescriber_name, p.prescribed_date, p.status, p.created_at from sales.prescriptions p where ${w} order by p.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async validate(auth: AuthContext, id: string) {
    const head = await this.load(auth, id, false);
    if (!auth.scopeFor('prescriptions.validate').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to validate prescriptions for this branch.');
    await this.db.tx(async (q) => {
      const r = await one<{ status: string }>(q, `select status from sales.prescriptions where id = $1 for update`, [id]);
      if (r.status !== 'pending_validation') throw AppError.conflict('PRESCRIPTION_NOT_PENDING', 'Only a prescription waiting for validation can be validated.');
      await q.query(`update sales.prescriptions set status = 'valid', validated_by = $2, validated_at = now(), version = version + 1 where id = $1`, [id, auth.userId]);
      await this.audit.record({ action: 'prescription.validated', entityType: 'prescription', entityId: id, branchId: head.branch_id }, q);
    });
    return this.load(auth, id, false);
  }

  async reject(auth: AuthContext, id: string, reason: string) {
    const head = await this.load(auth, id, false);
    if (!auth.scopeFor('prescriptions.validate').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to reject prescriptions for this branch.');
    await this.db.tx(async (q) => {
      const r = await one<{ status: string }>(q, `select status from sales.prescriptions where id = $1 for update`, [id]);
      if (r.status !== 'pending_validation') throw AppError.conflict('PRESCRIPTION_NOT_PENDING', 'Only a prescription waiting for validation can be rejected.');
      await q.query(`update sales.prescriptions set status = 'rejected', validated_by = $2, validated_at = now(), rejection_reason = $3, version = version + 1 where id = $1`, [id, auth.userId, reason]);
      await this.audit.record({ action: 'prescription.rejected', entityType: 'prescription', entityId: id, branchId: head.branch_id, newValue: { reason } }, q);
    });
    return this.load(auth, id, false);
  }

  async cancel(auth: AuthContext, id: string) {
    const head = await this.load(auth, id, false);
    if (!auth.scopeFor('prescriptions.manage').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to cancel prescriptions for this branch.');
    await this.db.tx(async (q) => {
      const r = await one<{ status: string }>(q, `select status from sales.prescriptions where id = $1 for update`, [id]);
      if (!['pending_validation', 'valid'].includes(r.status)) throw AppError.conflict('PRESCRIPTION_NOT_CANCELLABLE', 'This prescription can no longer be cancelled.');
      if (await maybeOne(q, `select 1 from sales.prescription_items where prescription_id = $1 and quantity_dispensed > 0`, [id])) throw AppError.conflict('PRESCRIPTION_ALREADY_DISPENSED', 'Part of this prescription has already been dispensed.');
      await q.query(`update sales.prescriptions set status = 'cancelled', version = version + 1 where id = $1`, [id]);
      await this.audit.record({ action: 'prescription.cancelled', entityType: 'prescription', entityId: id, branchId: head.branch_id }, q);
    });
    return this.load(auth, id, false);
  }

  /**
   * Called inside a sale. Checks the prescription is usable, matches each product line to a prescription item, and
   * records the quantity dispensed. Returns the prescription item each sale line was dispensed against.
   */
  async dispense(q: PoolClient, auth: AuthContext, prescriptionId: string, lines: Array<{ productId: string; baseQuantity: string; mustBePrescribed: boolean }>, today: string): Promise<Map<string, string>> {
    const rx = await maybeOne<{ id: string; branch_id: string; status: string; prescribed_date: string }>(q, `select id, branch_id, status, prescribed_date from sales.prescriptions where id = $1 for update`, [prescriptionId]);
    if (!rx || !auth.scopeFor('prescriptions.read').includes(rx.branch_id)) throw AppError.badRequest('PRESCRIPTION_NOT_FOUND', 'The prescription does not exist.');
    if (rx.status !== 'valid') throw AppError.conflict('PRESCRIPTION_NOT_VALID', `The prescription is ${rx.status.replace(/_/g, ' ')} and cannot be dispensed.`);
    const validity = await this.settings.get('prescriptions.validity_days', null, q);
    if (validity > 0) {
      const last = new Date(`${rx.prescribed_date}T00:00:00Z`); last.setUTCDate(last.getUTCDate() + validity);
      if (last.toISOString().slice(0, 10) < today) throw AppError.conflict('PRESCRIPTION_EXPIRED', 'The prescription is older than the allowed validity period.');
    }
    const items = await many<{ id: string; product_id: string; quantity_prescribed: string; quantity_dispensed: string }>(q, `select id, product_id, quantity_prescribed, quantity_dispensed from sales.prescription_items where prescription_id = $1 order by id for update`, [prescriptionId]);
    const linked = new Map<string, string>();
    const running = new Map(items.map((i) => [i.id, format(parse(i.quantity_dispensed))]));
    for (const l of lines) {
      const item = items.find((i) => i.product_id === l.productId);
      if (!item) { if (l.mustBePrescribed) throw AppError.conflict('NOT_ON_PRESCRIPTION', 'A medicine that needs a prescription is not on the prescription.', { productId: l.productId }); continue; }
      const used = running.get(item.id)!;
      const next = format(parse(used) + parse(l.baseQuantity));
      if (cmp(next, item.quantity_prescribed) > 0) throw AppError.conflict('EXCEEDS_PRESCRIPTION', 'More is being dispensed than the prescription allows.', { productId: l.productId, prescribed: format(parse(item.quantity_prescribed)), alreadyDispensed: used, attempted: l.baseQuantity });
      running.set(item.id, next);
      linked.set(`${l.productId}`, item.id);
    }
    for (const [itemId, qty] of running) await q.query(`update sales.prescription_items set quantity_dispensed = $2 where id = $1`, [itemId, qty]);
    const done = await one<{ open: string }>(q, `select count(*) as open from sales.prescription_items where prescription_id = $1 and quantity_dispensed < quantity_prescribed`, [prescriptionId]);
    if (Number(done.open) === 0) await q.query(`update sales.prescriptions set status = 'fulfilled', version = version + 1 where id = $1`, [prescriptionId]);
    return linked;
  }

  /** Undoes a dispense when a sale is cancelled. */
  async undoDispense(q: PoolClient, prescriptionId: string, items: Array<{ prescription_item_id: string | null; base_quantity: string }>) {
    for (const i of items) if (i.prescription_item_id) await q.query(`update sales.prescription_items set quantity_dispensed = quantity_dispensed - $2 where id = $1`, [i.prescription_item_id, i.base_quantity]);
    await q.query(`update sales.prescriptions set status = 'valid', version = version + 1 where id = $1 and status = 'fulfilled'`, [prescriptionId]);
  }

  // ---- attachments (scans of the paper prescription) ----
  private safePath(name: string): string {
    const full = resolve(this.root, name);
    if (!full.startsWith(this.root + sep)) throw AppError.notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found.');
    return full;
  }

  async saveAttachment(auth: AuthContext, id: string, data: Buffer) {
    const head = await this.load(auth, id, false);
    if (!auth.scopeFor('prescriptions.manage').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to attach files to prescriptions for this branch.');
    if (data.length === 0) throw AppError.badRequest('EMPTY_FILE', 'The file is empty.');
    if (data.length > MAX_ATTACHMENT) throw AppError.badRequest('FILE_TOO_LARGE', 'Attachments can be at most 5 MB.');
    const kind = sniffDocument(data);
    if (!kind) throw AppError.badRequest('UNSUPPORTED_FILE', 'Only PDF, PNG, JPEG and WebP files are accepted.');
    await mkdir(this.root, { recursive: true });
    const name = `${id}-${randomBytes(8).toString('hex')}.${kind.ext}`;
    await writeFile(join(this.root, name), data, { flag: 'wx', mode: 0o640 });
    const old = await maybeOne<{ attachment_path: string | null }>(this.db, `select attachment_path from sales.prescriptions where id = $1`, [id]);
    await this.db.tx(async (q) => {
      await q.query(`update sales.prescriptions set attachment_path = $2, attachment_mime = $3, version = version + 1 where id = $1`, [id, name, kind.mime]);
      await this.audit.record({ action: 'prescription.attachment_added', entityType: 'prescription', entityId: id, branchId: head.branch_id, newValue: { bytes: data.length, type: kind.mime } }, q);
    });
    if (old?.attachment_path) await unlink(this.safePath(old.attachment_path)).catch(() => undefined);
    return { id, size: data.length, type: kind.mime };
  }

  async readAttachment(auth: AuthContext, id: string): Promise<{ data: Buffer; mime: string; name: string }> {
    const head = await this.load(auth, id, false);
    const row = await one<{ attachment_path: string | null; attachment_mime: string | null }>(this.db, `select attachment_path, attachment_mime from sales.prescriptions where id = $1`, [id]);
    if (!row.attachment_path) throw AppError.notFound('ATTACHMENT_NOT_FOUND', 'This prescription has no attachment.');
    await this.audit.record({ action: 'prescription.attachment_viewed', entityType: 'prescription', entityId: id, branchId: head.branch_id });
    try { return { data: await readFile(this.safePath(row.attachment_path)), mime: row.attachment_mime ?? 'application/octet-stream', name: row.attachment_path }; }
    catch (e) { if (e instanceof AppError) throw e; throw AppError.notFound('ATTACHMENT_NOT_FOUND', 'This prescription has no attachment.'); }
  }
}
export { sub };
