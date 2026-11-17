import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { IsDecimal } from '../../common/validators';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const METHOD = /^[a-z0-9_]{2,30}$/;

export class CreateAccountDto { @Matches(/^[0-9A-Za-z.-]{2,20}$/) code: string; @IsString() @MinLength(1) @MaxLength(120) name: string; @IsIn(['asset', 'liability', 'equity', 'revenue', 'expense']) type: string; @IsOptional() @IsString() @MaxLength(300) note?: string }
export class UpdateAccountDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string; @IsOptional() @IsString() @MaxLength(300) note?: string; @IsOptional() @IsBoolean() isActive?: boolean; @IsOptional() @IsIn(['asset', 'liability', 'equity', 'revenue', 'expense']) type?: string }
export class SetMappingDto { @IsUUID() accountId: string }
export class CreatePeriodDto { @IsString() @MinLength(1) @MaxLength(40) name: string; @IsDateString() startDate: string; @IsDateString() endDate: string }
export class GenerateYearDto { @IsInt() @Min(2000) @Max(2100) year: number }
export class ReopenPeriodDto { @IsString() @MinLength(3) @MaxLength(300) note: string }

export class ManualLineDto { @IsUUID() account: string; @IsOptional() @IsDecimal() debit?: string; @IsOptional() @IsDecimal() credit?: string; @IsOptional() @IsString() @MaxLength(200) memo?: string }
export class ManualJournalDto {
  @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsDateString() entryDate?: string; @IsString() @MinLength(3) @MaxLength(300) description: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ManualLineDto) lines: ManualLineDto[];
}
export class EntriesQuery extends PageQuery {
  @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string; @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsString() @MaxLength(60) eventCode?: string; @IsOptional() @IsString() @MaxLength(40) sourceType?: string; @IsOptional() @IsUUID() sourceId?: string;
}

export class SaveCategoryDto { @IsOptional() @Matches(/^[a-z0-9_]{2,30}$/) code?: string; @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string; @IsOptional() @IsUUID() accountId?: string; @IsOptional() @IsBoolean() isActive?: boolean; @IsOptional() @IsInt() @Min(1) version?: number }
export class CreateExpenseDto {
  @IsUUID() branchId: string; @IsUUID() categoryId: string; @IsDecimal() amount: string; @Matches(METHOD) methodCode: string; @IsOptional() @IsDateString() expenseDate?: string;
  @IsOptional() @IsString() @MaxLength(150) payee?: string; @IsString() @MinLength(2) @MaxLength(300) description: string; @IsOptional() @IsString() @MaxLength(100) externalRef?: string; @IsOptional() @IsUUID() registerId?: string;
}
export class CreateIncomeDto {
  @IsUUID() branchId: string; @IsUUID() categoryId: string; @IsDecimal() amount: string; @Matches(METHOD) methodCode: string; @IsOptional() @IsDateString() incomeDate?: string;
  @IsOptional() @IsString() @MaxLength(150) payer?: string; @IsString() @MinLength(2) @MaxLength(300) description: string; @IsOptional() @IsString() @MaxLength(100) externalRef?: string; @IsOptional() @IsUUID() registerId?: string;
}
export class FinanceReasonDto { @IsString() @MinLength(3) @MaxLength(300) reason: string }
export class ExpensesQuery extends PageQuery { @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsUUID() categoryId?: string; @IsOptional() @IsString() @MaxLength(30) status?: string; @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string }
export class IncomesQuery extends PageQuery { @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsUUID() categoryId?: string; @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string }

export class OpenSessionDto { @IsUUID() registerId: string; @IsDecimal() openingAmount: string }
export class CloseSessionDto { @IsDecimal() countedAmount: string; @IsOptional() @IsString() @MaxLength(300) note?: string }
export class SessionsQuery extends PageQuery {
  @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsUUID() registerId?: string; @IsOptional() @IsIn(['open', 'closed']) status?: string; @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(bool) @IsBoolean() withVariance?: boolean;
}

export class RangeQuery { @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string; @IsOptional() @IsUUID() branchId?: string }
export class AsOfQuery { @IsOptional() @IsDateString() asOf?: string; @IsOptional() @IsUUID() branchId?: string }
export class DailyClosingQuery { @IsUUID() branchId: string; @IsDateString() date: string }
