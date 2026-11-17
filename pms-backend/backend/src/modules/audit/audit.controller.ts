import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService } from '../../database/database.service';

class AuditQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(100) entityType?: string;
  @IsOptional() @IsString() @MaxLength(100) entityId?: string;
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('audit.read')
  async list(@Auth() auth: AuthContext, @Query() q: AuditQuery): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where: string[] = [auth.scopeFor('audit.read').sql('a.branch_id', params)];
    const add = (cond: string, value: unknown) => { params.push(value); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.entityType) add('a.entity_type = ?', q.entityType);
    if (q.entityId) add('a.entity_id = ?', q.entityId);
    if (q.action) add('a.action = ?', q.action);
    if (q.userId) add('a.user_id = ?', q.userId);
    if (q.from) add('a.occurred_at >= ?', q.from);
    if (q.to) add('a.occurred_at <= ?', q.to);
    const whereSql = where.join(' and ');

    const total = Number((await this.db.query(`select count(*) from audit.audit_logs a where ${whereSql}`, params)).rows[0].count);
    const rows = await this.db.query(
      `select a.id, a.occurred_at, a.user_id, u.username, a.branch_id, a.action, a.entity_type, a.entity_id,
              a.old_value, a.new_value, a.ip_address, a.request_id
         from audit.audit_logs a left join iam.users u on u.id = a.user_id
        where ${whereSql}
        order by a.occurred_at ${q.order === 'asc' ? 'asc' : 'desc'}, a.id
        limit ${q.pageSize} offset ${offsetOf(q)}`,
      params,
    );
    return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
  }
}
