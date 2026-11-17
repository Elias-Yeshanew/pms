import { IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class CreateBranchDto {
  @Matches(/^[A-Z0-9_-]{2,20}$/, { message: 'code must be 2-20 characters: capital letters, digits, underscore or hyphen' }) code: string;
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() isCentral?: boolean;
}

export class UpdateBranchDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}

export class CreateEmployeeDto {
  @IsUUID() branchId: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsString() @MinLength(1) @MaxLength(150) fullName: string;
  @IsOptional() @IsString() @MaxLength(100) jobTitle?: string;
  @IsOptional() @IsDateString() hireDate?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
}

export class UpdateEmployeeDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(150) fullName?: string;
  @IsOptional() @IsString() @MaxLength(100) jobTitle?: string;
  @IsOptional() @IsDateString() hireDate?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsIn(['active', 'on_leave', 'terminated']) employmentStatus?: 'active' | 'on_leave' | 'terminated';
}

export class EmployeesQuery extends PageQuery {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsIn(['active', 'on_leave', 'terminated']) employmentStatus?: string;
}

export class CreateDepartmentDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
}
