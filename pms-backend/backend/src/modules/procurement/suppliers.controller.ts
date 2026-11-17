import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { PageQuery } from '../../common/pagination';
import { IsDecimal } from '../../common/validators';
import { SuppliersService } from './suppliers.service';

class SuppliersQuery extends PageQuery { @IsOptional() @IsIn(['active', 'inactive', 'blocked']) status?: string }
class CreateSupplierDto {
  @IsOptional() @Matches(/^[A-Z0-9_-]{2,20}$/) code?: string;
  @IsString() @MinLength(1) @MaxLength(150) name: string;
  @IsOptional() @IsString() @MaxLength(100) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(60) taxId?: string;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @IsDecimal() creditLimit?: string;
  @IsOptional() @IsString() @MaxLength(500) bankDetails?: string;
  @IsOptional() @Matches(/^[0-5](\.\d{1,2})?$/, { message: 'rating must be between 0 and 5' }) rating?: string;
}
class UpdateSupplierDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(100) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(60) taxId?: string;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @IsDecimal() creditLimit?: string;
  @IsOptional() @IsString() @MaxLength(500) bankDetails?: string;
  @IsOptional() @Matches(/^[0-5](\.\d{1,2})?$/) rating?: string;
  @IsOptional() @IsIn(['active', 'inactive', 'blocked']) status?: 'active' | 'inactive' | 'blocked';
}
class LinkProductDto { @IsOptional() @IsString() @MaxLength(60) supplierSku?: string; @IsOptional() @IsDecimal() lastPrice?: string }

@ApiTags('Suppliers')
@ApiBearerAuth()
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get() @RequirePermission('suppliers.read')
  list(@Query() q: SuppliersQuery) { return this.suppliers.list(q); }
  @Post() @RequirePermission('suppliers.manage')
  create(@Auth() a: AuthContext, @Body() dto: CreateSupplierDto) { return this.suppliers.create(a, dto); }
  @Get(':id') @RequirePermission('suppliers.read')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.suppliers.get(id); }
  @Patch(':id') @RequirePermission('suppliers.manage')
  update(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) { return this.suppliers.update(a, id, dto); }

  @Get(':id/products') @RequirePermission('suppliers.read')
  products(@Param('id', ParseUUIDPipe) id: string) { return this.suppliers.listProducts(id); }
  @Put(':id/products/:productId') @RequirePermission('suppliers.manage')
  link(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: LinkProductDto) { return this.suppliers.linkProduct(a, id, productId, dto); }
  @Delete(':id/products/:productId') @HttpCode(204) @RequirePermission('suppliers.manage')
  async unlink(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('productId', ParseUUIDPipe) productId: string) { await this.suppliers.unlinkProduct(a, id, productId); }
}
