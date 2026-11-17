import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV, Env } from '../../config/env';
import { AccessGuard } from './access.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MessagingService } from './messaging.service';
import { PasswordService } from './password.service';
import { PermissionService } from './permission.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { TokenService } from './token.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.JWT_ACCESS_SECRET, signOptions: { algorithm: 'HS256' } }),
    }),
  ],
  controllers: [AuthController, UsersController, RolesController],
  providers: [
    PasswordService, TokenService, PermissionService, MessagingService, AuthService, UsersService, RolesService,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [PermissionService, PasswordService, TokenService, MessagingService],
})
export class IamModule {}
