import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Auth, AllowPasswordChange, Public } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { AuthService } from './auth.service';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, LogoutDto, RefreshDto, ResetPasswordDto } from './auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @UseGuards(ThrottlerGuard) @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.username, dto.password, dto.deviceLabel);
  }

  @Public() @UseGuards(ThrottlerGuard) @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth() @AllowPasswordChange() @Post('logout') @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Body() dto: LogoutDto) {
    await this.auth.logout(auth, dto.everywhere === true);
  }

  @ApiBearerAuth() @AllowPasswordChange() @Get('me')
  me(@Auth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @ApiBearerAuth() @AllowPasswordChange() @Post('change-password') @HttpCode(204)
  async changePassword(@Auth() auth: AuthContext, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(auth, dto.currentPassword, dto.newPassword);
  }

  @ApiBearerAuth() @Get('sessions')
  sessions(@Auth() auth: AuthContext) {
    return this.auth.listSessions(auth.userId, auth.sessionId);
  }

  @ApiBearerAuth() @Delete('sessions/:id') @HttpCode(204)
  async revoke(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeSession(auth, id);
  }

  @Public() @UseGuards(ThrottlerGuard) @Post('forgot-password') @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.identifier);
    return { message: 'If the account exists and has an email address, reset instructions have been sent.' };
  }

  @Public() @UseGuards(ThrottlerGuard) @Post('reset-password') @HttpCode(204)
  async reset(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
  }
}
