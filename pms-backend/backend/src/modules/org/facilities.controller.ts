import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { FacilitiesService } from './facilities.service';

const CODE = /^[A-Z0-9_-]{1,20}$/;
const STATUS = ['active', 'inactive'];
class BranchFilter { @IsOptional() @IsUUID() branchId?: string }
class WarehouseFilter { @IsUUID() warehouseId: string }
class CreateWarehouseDto { @IsUUID() branchId: string; @Matches(CODE) code: string; @IsString() @MinLength(1) @MaxLength(100) name: string }
class UpdateWarehouseDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string; @IsOptional() @IsIn(STATUS) status?: 'active' | 'inactive' }
class CreateLocationDto {
  @IsUUID() warehouseId: string; @Matches(CODE) code: string; @IsString() @MinLength(1) @MaxLength(100) name: string;
  @IsOptional() @IsIn(['ambient', 'cool', 'cold', 'frozen']) temperatureZone?: string;
}
class UpdateLocationDto {
  @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsIn(['ambient', 'cool', 'cold', 'frozen']) temperatureZone?: string; @IsOptional() @IsIn(STATUS) status?: 'active' | 'inactive';
}
const OFFLINE = ['online_only', 'offline_capable', 'hybrid'];
class CreateRegisterDto { @IsUUID() branchId: string; @Matches(CODE) code: string; @IsString() @MinLength(1) @MaxLength(100) name: string; @IsOptional() @IsIn(OFFLINE) offlineMode?: string }
class UpdateRegisterDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string; @IsOptional() @IsIn(STATUS) status?: 'active' | 'inactive'; @IsOptional() @IsIn(OFFLINE) offlineMode?: string }

@ApiTags('Facilities')
@ApiBearerAuth()
@Controller()
export class FacilitiesController {
  constructor(private readonly f: FacilitiesService) {}

  @Get('warehouses') @RequirePermission('warehouses.read')
  warehouses(@Auth() a: AuthContext, @Query() q: BranchFilter) { return this.f.listWarehouses(a, q.branchId); }
  @Post('warehouses') @RequirePermission('warehouses.manage')
  createWarehouse(@Auth() a: AuthContext, @Body() dto: CreateWarehouseDto) { return this.f.createWarehouse(a, dto); }
  @Patch('warehouses/:id') @RequirePermission('warehouses.manage')
  updateWarehouse(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) { return this.f.updateWarehouse(a, id, dto); }

  @Get('storage-locations') @RequirePermission('warehouses.read')
  locations(@Auth() a: AuthContext, @Query() q: WarehouseFilter) { return this.f.listLocations(a, q.warehouseId); }
  @Post('storage-locations') @RequirePermission('warehouses.manage')
  createLocation(@Auth() a: AuthContext, @Body() dto: CreateLocationDto) { return this.f.createLocation(a, dto); }
  @Patch('storage-locations/:id') @RequirePermission('warehouses.manage')
  updateLocation(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) { return this.f.updateLocation(a, id, dto); }

  @Get('cash-registers') @RequirePermission('registers.read')
  registers(@Auth() a: AuthContext, @Query() q: BranchFilter) { return this.f.listRegisters(a, q.branchId); }
  @Post('cash-registers') @RequirePermission('registers.manage')
  createRegister(@Auth() a: AuthContext, @Body() dto: CreateRegisterDto) { return this.f.createRegister(a, dto); }
  @Patch('cash-registers/:id') @RequirePermission('registers.manage')
  updateRegister(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRegisterDto) { return this.f.updateRegister(a, id, dto); }
}
