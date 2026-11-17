import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { PageQuery } from '../../common/pagination';
import { CreateSaleBody } from '../sales/sales.dto';
import { SyncService } from './sync.service';

const id = () => Param('id', ParseUUIDPipe);
class RegisterDeviceBody { @IsString() @MinLength(2) @MaxLength(80) name: string; @IsOptional() @IsString() @MaxLength(60) platform?: string; @IsOptional() @IsUUID() registerId?: string; @IsOptional() @IsUUID() branchId?: string }
class DevicesQuery extends PageQuery { @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsIn(['active', 'revoked']) status?: string }
class DeviceQuery { @IsUUID() deviceId: string }
class SnapshotQuery extends DeviceQuery { @IsOptional() @IsUUID() afterId?: string; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number }
class ChangesQuery extends DeviceQuery { @Type(() => Number) @IsInt() @Min(0) since: number; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number }
class OfflineSaleBody extends CreateSaleBody {
  @IsString() @MinLength(4) @MaxLength(100) offlineRef: string;
  @IsDateString() soldAt: string;
}
class UploadSalesBody {
  @IsUUID() deviceId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OfflineSaleBody) sales: OfflineSaleBody[];
}
class ConflictsQuery extends PageQuery { @IsOptional() @IsIn(['open', 'resolved', 'dismissed']) status?: string; @IsOptional() @IsUUID() branchId?: string }
class DismissBody { @IsString() @MinLength(3) @MaxLength(500) note: string }

/** Everything an offline-capable register needs: sign the device in, download the catalogue, follow changes, upload sales. */
@ApiTags('Offline sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('devices') @RequirePermission('sales.create') register(@Auth() a: AuthContext, @Body() d: RegisterDeviceBody) { return this.sync.registerDevice(a, d); }
  @Get('devices') @RequirePermission('sync.manage') devices(@Auth() a: AuthContext, @Query() q: DevicesQuery) { return this.sync.listDevices(a, q); }
  @Post('devices/:id/revoke') @HttpCode(200) @RequirePermission('sync.manage') revoke(@Auth() a: AuthContext, @id() id: string) { return this.sync.revokeDevice(a, id); }

  @Get('cursor') @RequirePermission('sales.create') cursor(@Auth() a: AuthContext, @Query() q: DeviceQuery) { return this.sync.cursor(a, q.deviceId); }
  @Get('snapshot/:entity') @RequirePermission('sales.create') snapshot(@Auth() a: AuthContext, @Param('entity') entity: string, @Query() q: SnapshotQuery) { return this.sync.snapshot(a, q.deviceId, entity, q.afterId, q.limit ?? 500); }
  @Get('stock') @RequirePermission('sales.create') stock(@Auth() a: AuthContext, @Query() q: DeviceQuery) { return this.sync.stock(a, q.deviceId); }
  @Get('changes') @RequirePermission('sales.create') changes(@Auth() a: AuthContext, @Query() q: ChangesQuery) { return this.sync.changes(a, q.deviceId, q.since, q.limit ?? 500); }

  @Post('sales') @HttpCode(200) @RequirePermission('sales.create') upload(@Auth() a: AuthContext, @Body() d: UploadSalesBody) { return this.sync.uploadSales(a, d.deviceId, d.sales); }

  @Get('conflicts') @RequirePermission('sync.resolve') conflicts(@Auth() a: AuthContext, @Query() q: ConflictsQuery) { return this.sync.listConflicts(a, q); }
  @Get('my-conflicts') @RequirePermission('sales.create') mine(@Auth() a: AuthContext, @Query() q: ConflictsQuery) { return this.sync.myConflicts(a, q); }
  @Post('conflicts/:id/retry') @HttpCode(200) @RequirePermission('sales.create') retry(@Auth() a: AuthContext, @id() id: string) { return this.sync.retryConflict(a, id); }
  @Post('conflicts/:id/dismiss') @HttpCode(200) @RequirePermission('sync.resolve') dismiss(@Auth() a: AuthContext, @id() id: string, @Body() d: DismissBody) { return this.sync.dismissConflict(a, id, d.note); }
}
