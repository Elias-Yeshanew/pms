import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class ImportQuery { @IsOptional() @Transform(bool) @IsBoolean() autoCreate?: boolean }
export class CommitImportDto { @IsOptional() @IsBoolean() skipInvalid?: boolean; @IsOptional() @IsBoolean() confirmDuplicates?: boolean }

export class BulkPreviewBody {
  @IsIn(['purchase', 'selling', 'wholesale']) priceType: 'purchase' | 'selling' | 'wholesale';
  @IsIn(['set', 'percent', 'amount']) mode: 'set' | 'percent' | 'amount';
  /** For "set" a price; for "percent" a percentage such as 5 or -10; for "amount" a signed amount to add. */
  @Matches(/^-?\d{1,14}(\.\d{1,4})?$/, { message: 'value must be a decimal number with at most 4 decimal places' }) value: string;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @IsUUID('all', { each: true }) productIds?: string[];
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() manufacturerId?: string;
  @IsOptional() @IsUUID() unitId?: string;
}
export class BulkListQuery extends PageQuery { @IsOptional() @IsIn(['draft', 'pending', 'applied', 'rejected', 'cancelled']) status?: string }

export class GenerateBarcodeDto { @IsUUID() unitId: string }
class LabelItem { @IsUUID() productId: string; @IsUUID() barcodeId: string; @IsInt() @Min(1) @Max(100) copies: number }
export class LabelSheetDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LabelItem) items: LabelItem[];
  @IsOptional() @IsInt() @Min(1) @Max(6) columns?: number;
}
