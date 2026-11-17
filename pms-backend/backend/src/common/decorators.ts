import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthContext, AuthedRequest } from './auth-types';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const ALLOW_PASSWORD_CHANGE = 'allowPasswordChange';

/** Endpoint needs no login. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Endpoint needs ALL of the listed permissions (in any branch scope; services narrow it further). */
export const RequirePermission = (...codes: string[]) => SetMetadata(REQUIRED_PERMISSIONS, codes);
/** Endpoint stays reachable while the user must still change their password. */
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().auth;
});
