import { Controller, Get, Header, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { AppError } from '../../common/app-error';
import { Auth } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { DatabaseService, maybeOne } from '../../database/database.service';
import { SettingsService } from '../platform/settings.service';
import { AuditService } from '../audit/audit.service';
import { PRESETS, Preset } from './period';
import { ExportService } from './export.service';
import { ReportFilters, ReportsService } from './reports.service';

class ReportQuery {
  @IsOptional() @IsIn(PRESETS as unknown as string[]) period?: Preset;
  @IsOptional() @IsDateString({ strict: true } as never) from?: string;
  @IsOptional() @IsDateString({ strict: true } as never) to?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
}
class ExportQuery extends ReportQuery { @IsOptional() @IsIn(['xlsx', 'pdf', 'csv']) format?: 'xlsx' | 'pdf' | 'csv' }
const filters = (q: ReportQuery): ReportFilters => ({ preset: q.period, from: q.from?.slice(0, 10), to: q.to?.slice(0, 10), branchId: q.branchId, limit: q.limit });

/** Reports are read-only views of what has been recorded; each one needs the permission of the area it covers, and only shows the caller's branches. */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService, private readonly exporter: ExportService, private readonly db: DatabaseService, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  @Get('reports') list(@Auth() a: AuthContext) { return this.reports.catalog(a); }
  @Get('reports/:code') run(@Auth() a: AuthContext, @Param('code') code: string, @Query() q: ReportQuery) { return this.reports.run(a, code, filters(q)); }

  @Get('reports/:code/export') @Header('Cache-Control', 'no-store')
  async export(@Auth() a: AuthContext, @Param('code') code: string, @Query() q: ExportQuery, @Res({ passthrough: true }) res: Response) {
    const fmt = q.format ?? 'xlsx';
    const r = await this.reports.run(a, code, { ...filters(q), limit: q.limit ?? 1000 });
    const business = String(await this.settings.get('business.name', null).catch(() => 'Pharmacy'));
    const branch = q.branchId ? (await maybeOne<{ name: string }>(this.db, `select name from org.branches where id = $1`, [q.branchId]))?.name ?? null : null;
    const buf = fmt === 'xlsx' ? await this.exporter.xlsx(r, business, branch) : fmt === 'pdf' ? await this.exporter.pdf(r, business, branch) : this.exporter.csv(r);
    const type = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8' }[fmt];
    const name = `${code}${r.period ? `_${r.period.from}_${r.period.to}` : `_${new Date().toISOString().slice(0, 10)}`}.${fmt}`;
    res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
    await this.audit.record({ action: 'report.exported', entityType: 'report', entityId: null, branchId: q.branchId ?? null, newValue: { code, format: fmt, rows: r.rows.length } } as never);
    return new StreamableFile(buf);
  }

  @Get('dashboards') dashboards(@Auth() a: AuthContext) { return this.reports.listDashboards(a); }
  @Get('dashboards/:role') dashboard(@Auth() a: AuthContext, @Param('role') role: string, @Query() q: ReportQuery) { return this.reports.dashboard(a, role, filters(q)); }
}
void AppError;
