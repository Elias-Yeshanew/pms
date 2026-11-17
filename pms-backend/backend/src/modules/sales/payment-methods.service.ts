import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { DatabaseService, many, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}
  list(activeOnly = false) { return many(this.db, `select id, code, name, is_cash, is_credit, requires_reference, is_active, sort_order, version from sales.payment_methods ${activeOnly ? 'where is_active' : ''} order by sort_order, name`); }
  async create(auth: AuthContext, dto: { code: string; name: string; isCash?: boolean; requiresReference?: boolean; sortOrder?: number }) {
    return this.db.tx(async (q) => {
      const m = await one(q, `insert into sales.payment_methods (code, name, is_cash, requires_reference, sort_order) values ($1, $2, $3, $4, $5) returning id, code, name, is_cash, is_credit, requires_reference, is_active, sort_order, version`,
        [dto.code, dto.name, dto.isCash === true, dto.requiresReference === true, dto.sortOrder ?? 100]);
      await this.audit.record({ action: 'payment_method.created', entityType: 'payment_method', entityId: m.id, newValue: dto }, q);
      return m;
    });
  }
  async update(auth: AuthContext, id: string, dto: { version: number; name?: string; requiresReference?: boolean; isActive?: boolean; sortOrder?: number }) {
    return this.db.tx(async (q) => {
      const m = await updateVersioned(q, 'sales.payment_methods', id, dto.version, { name: dto.name, requires_reference: dto.requiresReference, is_active: dto.isActive, sort_order: dto.sortOrder }, auth.userId, () => AppError.notFound('PAYMENT_METHOD_NOT_FOUND', 'Payment method not found.'));
      await this.audit.record({ action: 'payment_method.updated', entityType: 'payment_method', entityId: id, newValue: dto }, q);
      return { id: m.id, code: m.code, name: m.name, is_cash: m.is_cash, is_credit: m.is_credit, requires_reference: m.requires_reference, is_active: m.is_active, sort_order: m.sort_order, version: m.version };
    });
  }
}
