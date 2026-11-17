import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../../database/database.service';
import { RequestContextStore } from '../../common/request-context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  branchId?: string | null;
  /** Overrides the acting user (needed for login events, where no session exists yet). */
  userId?: string | null;
}

const SENSITIVE = /password|token|secret|hash/i;

/** Removes secrets so they can never end up in the audit trail. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /** Pass the transaction client so the audit record commits or rolls back with the change itself. */
  async record(entry: AuditEntry, q: Queryable = this.db): Promise<void> {
    const ctx = RequestContextStore.get();
    await q.query(
      `insert into audit.audit_logs
         (user_id, branch_id, device_id, action, entity_type, entity_id, old_value, new_value, ip_address, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.userId !== undefined ? entry.userId : ctx?.userId ?? null,
        entry.branchId ?? null,
        ctx?.deviceId ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.oldValue === undefined ? null : JSON.stringify(redact(entry.oldValue)),
        entry.newValue === undefined ? null : JSON.stringify(redact(entry.newValue)),
        ctx?.ip ?? null,
        ctx?.requestId ?? null,
      ],
    );
  }
}
