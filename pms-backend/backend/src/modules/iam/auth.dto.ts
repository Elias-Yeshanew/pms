import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString() @MinLength(1) @MaxLength(100) username: string;
  @IsString() @MinLength(1) @MaxLength(128) password: string;
  @IsOptional() @IsString() @MaxLength(100) deviceLabel?: string;
}

export class RefreshDto {
  @IsString() @MinLength(20) @MaxLength(200) refreshToken: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) currentPassword: string;
  @IsString() @MaxLength(128) newPassword: string;
}

export class ForgotPasswordDto {
  @IsString() @MinLength(3) @MaxLength(254) identifier: string;
}

export class ResetPasswordDto {
  @IsString() @MinLength(20) @MaxLength(200) token: string;
  @IsString() @MaxLength(128) newPassword: string;
}

export class LogoutDto {
  @IsOptional() @IsBoolean() everywhere?: boolean;
}
export { IsEmail };
