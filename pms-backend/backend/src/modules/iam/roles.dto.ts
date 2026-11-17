import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRoleDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @Matches(/^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$/, { each: true }) permissions?: string[];
}

export class UpdateRoleDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class SetRolePermissionsDto {
  @IsInt() @Min(1) version: number;
  @IsArray() @ArrayMaxSize(500) @Matches(/^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$/, { each: true }) permissions: string[];
}
