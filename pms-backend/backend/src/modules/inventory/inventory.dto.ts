import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { IsDecimal } from '../../common/validators';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const STATUSES = ['available', 'quarantined', 'damaged', 'expired'];

export class NewBatchDto {
  @IsString() @MinLength(1) @MaxLength(60) batchRef: string;
  @IsDateString({ strict: true }) expiryDate: string;
  @IsOptional() @IsDateString({ strict: true }) manufactureDate?: string;
  /** Cost of ONE BASE UNIT (for example one tablet). */
  @IsDecimal() unitCost: string;
  @IsOptional() @IsUUID() supplierId?: string;
}

export class AdjustmentItemDto {
  @IsUUID() productId: string;
  @IsOptional() @IsUUID() unitId?: string;
  @IsDecimal() quantity: string;
  @IsIn(['increase', 'decrease']) direction: 'increase' | 'decrease';
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @ValidateNested() @Type(() => NewBatchDto) newBatch?: NewBatchDto;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CreateAdjustmentDto {
  @IsUUID() warehouseId: string;
  @IsIn(['opening_balance', 'count_correction', 'loss', 'found', 'data_entry_error', 'other']) reasonCode: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AdjustmentItemDto) items: AdjustmentItemDto[];
}

export class DisposalItemDto {
  @IsUUID() batchId: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsIn(['quarantined', 'damaged', 'expired']) status: 'quarantined' | 'damaged' | 'expired';
  @IsDecimal() quantity: string;
  @IsOptional() @IsUUID() unitId?: string;
}

export class CreateDisposalDto {
  @IsUUID() warehouseId: string;
  @IsIn(['expired', 'damaged', 'returned', 'other']) reason: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DisposalItemDto) items: DisposalItemDto[];
}

export class StatusChangeDto {
  @IsUUID() warehouseId: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsUUID() batchId: string;
  @IsDecimal() quantity: string;
  @IsOptional() @IsUUID() unitId?: string;
  @IsIn(STATUSES) from: 'available' | 'quarantined' | 'damaged' | 'expired';
  @IsIn(STATUSES) to: 'available' | 'quarantined' | 'damaged' | 'expired';
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class SweepDto { @IsOptional() @IsUUID() branchId?: string }

export class StockQuery extends PageQuery {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @Transform(bool) @IsBoolean() includeZero?: boolean;
}

export class MovementsQuery extends PageQuery {
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @MaxLength(30) movementType?: string;
  @IsOptional() @IsString() @MaxLength(40) referenceNo?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class BranchQuery { @IsOptional() @IsUUID() branchId?: string }
export class ExpiringQuery extends BranchQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) withinDays?: number }
export class ProductQuery { @IsUUID() productId: string }
export class FefoQuery { @IsUUID() productId: string; @IsUUID() branchId: string; @IsDecimal() quantity: string; @IsOptional() @IsUUID() unitId?: string }
export class StatusFilter extends PageQuery { @IsOptional() @IsIn(['pending', 'posted', 'rejected', 'cancelled']) status?: string; @IsOptional() @IsUUID() branchId?: string }

export class TransferItemDto {
  @IsUUID() productId: string;
  @IsOptional() @IsUUID() unitId?: string;
  @IsDecimal() quantity: string;
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsUUID() fromLocationId?: string;
  @IsOptional() @IsUUID() toLocationId?: string;
}
export class CreateTransferDto {
  @IsUUID() fromWarehouseId: string;
  @IsUUID() toWarehouseId: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => TransferItemDto) items: TransferItemDto[];
}
class DispatchItemDto { @IsUUID() itemId: string; @IsDecimal() quantitySent: string }
export class DispatchDto { @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DispatchItemDto) items?: DispatchItemDto[] }
class ReceiveTransferItemDto {
  @IsUUID() itemId: string;
  @IsDecimal() quantityReceived: string;
  @IsOptional() @IsIn(['available', 'quarantined', 'damaged']) receivedStatus?: 'available' | 'quarantined' | 'damaged';
  @IsOptional() @IsUUID() toLocationId?: string;
  @IsOptional() @IsString() @MaxLength(300) discrepancyReason?: string;
}
export class ReceiveTransferDto { @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ReceiveTransferItemDto) items?: ReceiveTransferItemDto[] }
export class ResolveDto { @IsString() @MinLength(3) @MaxLength(500) note: string }

export class CreateCountDto { @IsUUID() warehouseId: string; @IsOptional() @IsUUID() locationId?: string; @IsOptional() @IsString() @MaxLength(300) note?: string }
class CountEntryDto { @IsUUID() itemId: string; @IsDecimal() countedQuantity: string; @IsOptional() @IsUUID() unitId?: string }
export class EnterCountsDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CountEntryDto) items: CountEntryDto[] }
export class ListFilter extends PageQuery {
  @IsOptional() @IsString() @MaxLength(30) status?: string;
  @IsOptional() @IsUUID() branchId?: string;
}
