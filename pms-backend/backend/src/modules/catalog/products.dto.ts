import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { IsDecimal } from '../../common/validators';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
const PRICE_TYPES = ['purchase', 'selling', 'wholesale'];

export class UnitConfigDto {
  @IsUUID() unitId: string;
  /** How many base units one of this unit contains, e.g. 10 for a strip of 10 tablets. */
  @IsDecimal() factorToBase: string;
  @IsOptional() @IsBoolean() isSellable?: boolean;
  @IsOptional() @IsBoolean() isPurchasable?: boolean;
}
export class BarcodeDto {
  @IsUUID() unitId: string;
  @Matches(/^[A-Za-z0-9._/-]{4,64}$/, { message: 'barcode must be 4-64 characters: letters, digits, . _ / -' }) barcode: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
export class InitialPriceDto {
  @IsUUID() unitId: string;
  @IsIn(PRICE_TYPES) priceType: 'purchase' | 'selling' | 'wholesale';
  @IsDecimal() amount: string;
}

class ProductFields {
  @IsOptional() @IsString() @MaxLength(200) genericName?: string;
  @IsOptional() @IsString() @MaxLength(200) brandName?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() manufacturerId?: string;
  @IsOptional() @IsUUID() dosageFormId?: string;
  @IsOptional() @IsString() @MaxLength(100) strength?: string;
  @IsOptional() @IsBoolean() requiresPrescription?: boolean;
  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @IsString() @MaxLength(100) registrationNo?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsDecimal() minStock?: string;
  @IsOptional() @IsDecimal() maxStock?: string;
  @IsOptional() @IsDecimal() reorderLevel?: string;
  @IsOptional() @IsUUID() taxCategoryId?: string;
}

export class CreateProductDto extends ProductFields {
  @IsOptional() @Matches(/^[A-Za-z0-9._-]{1,40}$/) sku?: string;
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsUUID() baseUnitId: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => UnitConfigDto) units?: UnitConfigDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => BarcodeDto) barcodes?: BarcodeDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => InitialPriceDto) prices?: InitialPriceDto[];
  /** Set to true to register a product even though a very similar one exists. */
  @IsOptional() @IsBoolean() confirmDuplicate?: boolean;
}

export class UpdateProductDto extends ProductFields {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
}

export class VersionBody { @IsInt() @Min(1) version: number }
export class SetUnitsDto { @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => UnitConfigDto) units: UnitConfigDto[] }

export class ChangePriceDto {
  @IsUUID() unitId: string;
  @IsIn(PRICE_TYPES) priceType: 'purchase' | 'selling' | 'wholesale';
  @IsDecimal() amount: string;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ConvertDto {
  @IsDecimal() quantity: string;
  @IsUUID() fromUnitId: string;
  @IsUUID() toUnitId: string;
}

export class ProductsQuery extends PageQuery {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() manufacturerId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() requiresPrescription?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() isActive?: boolean;
}

export class CreateUnitDto { @Matches(/^[a-z0-9_]{1,30}$/) code: string; @IsString() @MinLength(1) @MaxLength(60) name: string }
export class UpdateUnitDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string; @IsOptional() @IsBoolean() isActive?: boolean }
export class CreateDosageFormDto { @IsString() @MinLength(2) @MaxLength(60) name: string }
export class CreateProductCategoryDto { @IsString() @MinLength(1) @MaxLength(100) name: string; @IsOptional() @IsUUID() parentId?: string }
export class UpdateProductCategoryDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string; @IsOptional() @IsUUID() parentId?: string; @IsOptional() @IsBoolean() isActive?: boolean }
export class CreateManufacturerDto { @IsString() @MinLength(1) @MaxLength(150) name: string; @IsOptional() @IsString() @MaxLength(60) country?: string }
export class UpdateManufacturerDto { @IsInt() @Min(1) version: number; @IsOptional() @IsString() @MinLength(1) @MaxLength(150) name?: string; @IsOptional() @IsString() @MaxLength(60) country?: string; @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive' }
