import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { IsDecimal } from '../../common/validators';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const date = () => IsDateString({ strict: true });
const lines = (n = 200) => [IsArray(), ArrayMinSize(1), ArrayMaxSize(n)];
const decorate = (...ds: PropertyDecorator[]) => (t: object, k: string) => ds.forEach((d) => d(t, k));

export class RequestItemDto { @IsUUID() productId: string; @IsOptional() @IsUUID() unitId?: string; @IsDecimal() quantity: string; @IsOptional() @IsString() @MaxLength(300) note?: string }
export class CreateRequestDto {
  @IsUUID() warehouseId: string; @IsOptional() @date() neededBy?: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
  @decorate(...lines(), ValidateNested({ each: true }), Type(() => RequestItemDto)) items: RequestItemDto[];
}

export class OrderItemDto { @IsUUID() productId: string; @IsOptional() @IsUUID() unitId?: string; @IsDecimal() quantity: string; @IsDecimal() unitPrice: string }
export class CreateOrderDto {
  @IsUUID() supplierId: string; @IsUUID() warehouseId: string; @IsOptional() @IsUUID() purchaseRequestId?: string;
  @IsOptional() @date() orderDate?: string; @IsOptional() @date() expectedDate?: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
  @decorate(...lines(), ValidateNested({ each: true }), Type(() => OrderItemDto)) items: OrderItemDto[];
}
export class UpdateOrderDto {
  @IsInt() @Min(1) version: number; @IsOptional() @IsUUID() supplierId?: string; @IsOptional() @date() expectedDate?: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @decorate(...lines(), ValidateNested({ each: true }), Type(() => OrderItemDto)) items?: OrderItemDto[];
}
export class ReviseOrderDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string; @IsOptional() @date() expectedDate?: string;
  @decorate(...lines(), ValidateNested({ each: true }), Type(() => OrderItemDto)) items: OrderItemDto[];
}
export class ProcurementReasonDto { @IsString() @MinLength(3) @MaxLength(500) reason: string }
export class OrdersQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(30) status?: string; @IsOptional() @IsUUID() supplierId?: string; @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @date() from?: string; @IsOptional() @date() to?: string;
  @IsOptional() @Transform(bool) @IsBoolean() outstanding?: boolean; @IsOptional() @Transform(bool) @IsBoolean() overdue?: boolean;
}
export class ListQuery extends PageQuery { @IsOptional() @IsString() @MaxLength(30) status?: string; @IsOptional() @IsUUID() branchId?: string; @IsOptional() @IsUUID() supplierId?: string; @IsOptional() @IsUUID() purchaseOrderId?: string }

export class ReceiveGoodsItemDto {
  @IsUUID() orderItemId: string; @IsDecimal() quantity: string; @IsOptional() @IsUUID() unitId?: string;
  @IsString() @MinLength(1) @MaxLength(60) batchRef: string; @date() expiryDate: string; @IsOptional() @date() manufactureDate?: string; @IsOptional() @IsUUID() locationId?: string;
}
export class ReceiveGoodsDto {
  @IsUUID() purchaseOrderId: string; @IsOptional() @IsString() @MaxLength(60) deliveryNoteNo?: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
  @decorate(...lines(), ValidateNested({ each: true }), Type(() => ReceiveGoodsItemDto)) items: ReceiveGoodsItemDto[];
}
class InspectItemDto { @IsUUID() itemId: string; @IsDecimal() acceptedQuantity: string; @IsOptional() @IsString() @MaxLength(300) rejectionReason?: string }
export class InspectDto { @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => InspectItemDto) items?: InspectItemDto[] }

export class CreateInvoiceDto {
  @IsUUID() purchaseOrderId: string; @IsString() @MinLength(1) @MaxLength(60) invoiceNo: string; @date() invoiceDate: string; @IsOptional() @date() dueDate?: string;
  @IsDecimal() subtotal: string; @IsDecimal() taxTotal: string; @IsDecimal() total: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class InvoicesQuery extends PageQuery {
  @IsOptional() @IsUUID() supplierId?: string; @IsOptional() @IsString() @MaxLength(30) status?: string; @IsOptional() @IsUUID() purchaseOrderId?: string; @IsOptional() @Transform(bool) @IsBoolean() overdue?: boolean;
}
class AllocationDto { @IsUUID() invoiceId: string; @IsDecimal() amount: string }
export class CreatePaymentDto {
  @IsUUID() supplierId: string; @IsOptional() @date() paymentDate?: string; @IsIn(['cash', 'bank_transfer', 'cheque', 'mobile_money', 'other']) method: string;
  @IsOptional() @IsString() @MaxLength(100) externalRef?: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
  @decorate(...lines(50), ValidateNested({ each: true }), Type(() => AllocationDto)) allocations: AllocationDto[];
}
export class ApplyCreditDto { @IsUUID() invoiceId: string; @IsDecimal() amount: string }
export class CreditsQuery { @IsOptional() @IsUUID() supplierId?: string }

class ReturnItemDto {
  @IsUUID() batchId: string; @IsIn(['quarantined', 'damaged']) status: 'quarantined' | 'damaged'; @IsDecimal() quantity: string; @IsOptional() @IsUUID() unitId?: string; @IsOptional() @IsUUID() locationId?: string;
}
export class CreateReturnDto {
  @IsUUID() supplierId: string; @IsUUID() warehouseId: string; @IsOptional() @IsUUID() receiptId?: string; @IsString() @MinLength(3) @MaxLength(500) reason: string; @IsOptional() @IsString() @MaxLength(500) note?: string;
  @decorate(...lines(100), ValidateNested({ each: true }), Type(() => ReturnItemDto)) items: ReturnItemDto[];
}

export class BranchFilter { @IsOptional() @IsUUID() branchId?: string }
export class AgingQuery extends BranchFilter { @IsOptional() @IsUUID() supplierId?: string }
export class ProductFilter { @IsUUID() productId: string }
export class RangeQuery { @IsOptional() @date() from?: string; @IsOptional() @date() to?: string }
