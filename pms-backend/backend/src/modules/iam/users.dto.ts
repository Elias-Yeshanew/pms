import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class RoleAssignmentDto {
  @IsUUID() roleId: string;
  /** Omit for a company-wide assignment. */
  @IsOptional() @IsUUID() branchId?: string | null;
}

export class CreateUserDto {
  @Matches(/^[A-Za-z0-9._-]{3,50}$/, { message: 'username must be 3-50 characters: letters, digits, dot, underscore or hyphen' }) username: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  /** If omitted, a one-time password is generated and returned once. */
  @IsOptional() @IsString() @MaxLength(128) password?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => RoleAssignmentDto) roles?: RoleAssignmentDto[];
}

export class UpdateUserDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

export class VersionDto {
  @IsInt() @Min(1) version: number;
}

export class SetRolesDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => RoleAssignmentDto) roles: RoleAssignmentDto[];
}

export class UsersQuery extends PageQuery {
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsUUID() branchId?: string;
}
