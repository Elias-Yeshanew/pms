import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { IsDecimal } from '../../common/validators';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const METHOD = /^[a-z0-9_]{2,30}$/;

export class SaleItemDto {
  @IsUUID() productId: string; @IsOptional() @IsUUID() unitId?: string; @IsDecimal() quantity: string;
  @IsOptional() @IsDecimal() discountPercent?: string; @IsOptional() @IsDecimal() discountAmount?: string;
}
export class SalePaymentDto {
  @Matches(METHOD) methodCode: string; @IsDecimal() amount: string; @IsOptional() @IsDecimal() tendered?: string; @IsOptional() @IsString() @MaxLength(100) reference?: string;
}
export class CreateSaleBody {
  @IsUUID() registerId: string;
  /** A new value for each sale attempt; reuse it when retrying the same sale. */
  @Matches(/^[A-Za-z0-9._:-]{8,100}$/, { message: 'idempotencyKey must be 8-100 characters: letters, digits, . _ : -' }) idempotencyKey: string;
  @IsOptional() @IsUUID() customerId?: string; @IsOptional() @IsUUID() prescriptionId?: string; @IsOptional() @IsUUID() warehouseId?: string; @IsOptional() @IsUUID() discountRequestId?: string;
  // deviceId, offlineRef and soldAt are deliberately not accepted here: only the offline sync upload may set them (see OfflineSaleBody).
  // Accepting them on the online route would let a client backdate a sale to an older price and skip the open-register check.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SaleItemDto) items: SaleItemDto[];
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SalePaymentDto) payments: SalePaymentDto[];
}
export class SalesQuery extends PageQuery {
  @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsUUID() cashierId?: string; @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsIn(['completed', 'partially_returned', 'returned', 'cancelled']) status?: string; @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string;
}
export class SummaryQuery { @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string; @IsOptional() @IsUUID() branchId?: string }
export class ReceiptQuery { @IsOptional() @Transform(bool) @IsBoolean() reprint?: boolean }
export class ReasonBody { @IsString() @MinLength(3) @MaxLength(500) reason: string }

export class CreatePaymentMethodDto { @Matches(METHOD) code: string; @IsString() @MinLength(1) @MaxLength(60) name: string; @IsOptional() @IsBoolean() isCash?: boolean; @IsOptional() @IsBoolean() requiresReference?: boolean; @IsOptional() @IsInt() @Min(0) sortOrder?: number }
export class UpdatePaymentMethodDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string; @IsOptional() @IsBoolean() requiresReference?: boolean; @IsOptional() @IsBoolean() isActive?: boolean; @IsOptional() @IsInt() @Min(0) sortOrder?: number }

export class CreateCustomerDto {
  @IsString() @MinLength(1) @MaxLength(150) name: string; @IsOptional() @IsString() @MaxLength(40) phone?: string; @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string; @IsOptional() @IsString() @MaxLength(500) notes?: string; @IsOptional() @IsDecimal() creditLimit?: string;
}
export class UpdateCustomerDto {
  @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(150) name?: string; @IsOptional() @IsString() @MaxLength(40) phone?: string; @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string; @IsOptional() @IsString() @MaxLength(500) notes?: string; @IsOptional() @IsDecimal() creditLimit?: string; @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}
export class CustomersQuery extends PageQuery { @IsOptional() @IsIn(['active', 'inactive']) status?: string; @IsOptional() @Transform(bool) @IsBoolean() owing?: boolean }
export class CustomerPaymentBody { @IsUUID() branchId: string; @IsOptional() @IsUUID() registerId?: string; @Matches(METHOD) methodCode: string; @IsDecimal() amount: string; @IsOptional() @IsString() @MaxLength(100) reference?: string }
export class RangeBody { @IsOptional() @IsDateString({ strict: true }) from?: string; @IsOptional() @IsDateString({ strict: true }) to?: string }

class RxItemDto {
  @IsUUID() productId: string; @IsOptional() @IsUUID() unitId?: string; @IsDecimal() quantity: string;
  @IsOptional() @IsString() @MaxLength(200) dosage?: string; @IsOptional() @IsString() @MaxLength(200) frequency?: string; @IsOptional() @IsString() @MaxLength(200) duration?: string; @IsOptional() @IsString() @MaxLength(300) notes?: string;
}
export class CreatePrescriptionDto {
  @IsUUID() branchId: string; @IsOptional() @IsUUID() customerId?: string; @IsOptional() @IsString() @MaxLength(150) patientName: string; @IsOptional() @IsDateString({ strict: true }) patientBirthDate?: string;
  @IsOptional() @IsString() @MaxLength(40) patientPhone?: string; @IsOptional() @IsString() @MaxLength(150) prescriberName: string; @IsOptional() @IsString() @MaxLength(60) prescriberLicenseNo?: string;
  @IsOptional() @IsString() @MaxLength(150) facility?: string; @IsOptional() @IsDateString({ strict: true }) prescribedDate: string; @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RxItemDto) items: RxItemDto[];
}
export class PrescriptionsQuery extends PageQuery { @IsOptional() @IsString() @MaxLength(30) status?: string; @IsOptional() @IsUUID() customerId?: string; @IsOptional() @IsUUID() branchId?: string }

export class DiscountRequestBody { @IsUUID() branchId: string; @IsOptional() @IsUUID() registerId?: string; @IsDecimal() percent: string; @IsString() @MinLength(3) @MaxLength(300) reason: string }

class ReturnLineDto { @IsUUID() saleItemId: string; @IsDecimal() quantity: string; @IsOptional() @IsUUID() unitId?: string }
export class CreateReturnBody {
  @IsUUID() saleId: string; @IsString() @MinLength(3) @MaxLength(500) reason: string; @IsOptional() @Matches(METHOD) refundMethodCode?: string; @IsOptional() @IsString() @MaxLength(100) refundReference?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ReturnLineDto) items: ReturnLineDto[];
}
class InspectLineDto { @IsUUID() itemId: string; @IsIn(['resale', 'damaged']) disposition: 'resale' | 'damaged'; @IsOptional() @IsString() @MaxLength(300) note?: string }
export class InspectReturnBody { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => InspectLineDto) items: InspectLineDto[] }
export class ReturnsQuery extends PageQuery { @IsOptional() @IsString() @MaxLength(30) status?: string; @IsOptional() @IsUUID() saleId?: string; @IsOptional() @IsUUID() branchId?: string }
