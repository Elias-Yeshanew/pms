import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../common/app-error';
import { AuthedRequest } from '../../common/auth-types';
import { ALLOW_PASSWORD_CHANGE, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { RequestContextStore } from '../../common/request-context';
import { DatabaseService, maybeOne } from '../../database/database.service';
import { PermissionService } from './permission.service';
import { TokenService } from './token.service';

interface SessionRow {
  user_id: string; username: string; user_status: string; must_change_password: boolean;
  revoked_at: Date | null; expires_at: Date;
}

/**
 * Global guard. Every request must carry a valid access token whose session is still active
 * (so logout, deactivation and revocation take effect immediately) and, where the route asks for
 * it, the required permissions. Routes are closed by default; only @Public() routes are open.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly perms: PermissionService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw AppError.unauthorized('AUTH_REQUIRED', 'Authentication is required.');

    const claims = await this.tokens.verifyAccess(token);
    if (!claims) throw AppError.unauthorized('AUTH_INVALID_TOKEN', 'The access token is invalid or has expired.');

    const session = await maybeOne<SessionRow>(
      this.db,
      `select s.user_id, u.username, u.status as user_status, u.must_change_password, s.revoked_at, s.expires_at
         from iam.sessions s join iam.users u on u.id = s.user_id
        where s.id = $1 and s.user_id = $2`,
      [claims.sid, claims.sub],
    );
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.user_status !== 'active') {
      throw AppError.unauthorized('AUTH_SESSION_ENDED', 'The session has ended. Please sign in again.');
    }

    if (session.must_change_password && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) {
      throw AppError.forbidden('PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.');
    }

    const set = await this.perms.forUser(session.user_id);
    req.auth = this.perms.toAuthContext(
      { userId: session.user_id, sessionId: claims.sid, username: session.username, mustChangePassword: session.must_change_password },
      set,
    );
    const ctx = RequestContextStore.get();
    if (ctx) ctx.userId = session.user_id;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((code) => !set.can(code));
    if (missing.length) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to perform this action.');
    return true;
  }
}
