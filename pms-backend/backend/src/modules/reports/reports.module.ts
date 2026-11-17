import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ controllers: [ReportsController], providers: [ReportsService, ExportService], exports: [ReportsService] })
export class ReportsModule {}
