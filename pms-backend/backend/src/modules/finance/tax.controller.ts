import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { IsDecimal } from '../../common/validators';
import { TaxService } from './tax.service';

const RATE = /^\d{1,3}(\.\d{1,4})?$/;
const ROUNDING = ['half_up', 'half_even', 'down', 'up'] as const;

class CreateTaxCategoryDto { @IsString() @MinLength(2) @MaxLength(80) name: string; @IsOptional() @IsString() @MaxLength(300) description?: string }
class UpdateTaxCategoryDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class CreateRuleDto {
  @IsUUID() taxCategoryId: string;
  @Matches(/^[A-Z0-9_-]{1,20}$/) taxCode: string;
  @IsString() @MinLength(1) @MaxLength(100) name: string;
  @Matches(RATE, { message: 'rate must be a percentage between 0 and 100 with at most 4 decimals' }) rate: string;
  @IsOptional() @IsBoolean() isInclusive?: boolean;
  @IsOptional() @IsIn(ROUNDING as unknown as string[]) roundingRule?: (typeof ROUNDING)[number];
  @IsDateString({ strict: true }) effectiveFrom: string;
  @IsOptional() @IsDateString({ strict: true }) effectiveTo?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) countryPack?: string;
}
class EndRuleDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsDateString({ strict: true }) effectiveTo?: string;
}
class SupersedeDto {
  @Matches(RATE) rate: string;
  @IsDateString({ strict: true }) effectiveFrom: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @Matches(/^[A-Z0-9_-]{1,20}$/) taxCode?: string;
  @IsOptional() @IsBoolean() isInclusive?: boolean;
  @IsOptional() @IsIn(ROUNDING as unknown as string[]) roundingRule?: (typeof ROUNDING)[number];
}
class RulesQuery { @IsOptional() @IsUUID() taxCategoryId?: string }
class ResolveQuery { @IsUUID() taxCategoryId: string; @IsOptional() @IsDateString({ strict: true }) date?: string }
class CalculateDto { @IsUUID() taxCategoryId: string; @IsDecimal() amount: string; @IsOptional() @IsDateString({ strict: true }) date?: string }

@ApiTags('Tax')
@ApiBearerAuth()
@Controller()
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get('tax-categories') @RequirePermission('tax.read')
  categories() { return this.tax.listCategories(); }

  @Post('tax-categories') @RequirePermission('tax.manage')
  createCategory(@Auth() auth: AuthContext, @Body() dto: CreateTaxCategoryDto) { return this.tax.createCategory(auth, dto); }

  @Patch('tax-categories/:id') @RequirePermission('tax.manage')
  updateCategory(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaxCategoryDto) { return this.tax.updateCategory(auth, id, dto); }

  @Get('tax-rules') @RequirePermission('tax.read')
  rules(@Query() q: RulesQuery) { return this.tax.listRules(q.taxCategoryId); }

  @Get('tax-rules/resolve') @RequirePermission('tax.read')
  resolve(@Query() q: ResolveQuery) { return this.tax.resolve(q.taxCategoryId, q.date); }

  @Post('tax-rules') @RequirePermission('tax.manage')
  createRule(@Auth() auth: AuthContext, @Body() dto: CreateRuleDto) { return this.tax.createRule(auth, dto); }

  @Patch('tax-rules/:id') @RequirePermission('tax.manage')
  endRule(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EndRuleDto) { return this.tax.endRule(auth, id, dto); }

  @Post('tax-rules/:id/supersede') @RequirePermission('tax.manage')
  supersede(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupersedeDto) { return this.tax.supersede(auth, id, dto); }

  @Post('tax/calculate') @HttpCode(200) @RequirePermission('tax.read')
  calculate(@Body() dto: CalculateDto) { return this.tax.calculate(dto); }
}
