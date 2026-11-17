import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { RequestContextStore } from '../../common/request-context';
import { ENV, Env } from '../../config/env';
import { DatabaseService, many, maybeOne, one, Queryable } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { MessagingService } from './messaging.service';
import { SettingsService } from '../platform/settings.service';
import { PasswordService } from './password.service';
import { PermissionService } from './permission.service';
import { TokenService } from './token.service';

interface UserRow {
  id: string; username: string; email: string | null; password_hash: string; status: string;
  must_change_password: boolean; failed_login_count: number; locked_until: Date | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get meta() {
    const ctx = RequestContextStore.get();
    return { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null };
  }

  private async logAttempt(username: string, userId: string | null, success: boolean, reason: string | null, sessionId: string | null = null, q: Queryable = this.db) {
    await q.query(
      `insert into iam.login_history (user_id, username_attempted, ip_address, user_agent, success, failure_reason, session_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, username.slice(0, 100), this.meta.ip, this.meta.userAgent, success, reason, sessionId],
    );
  }

  async login(username: string, password: string, deviceLabel?: string): Promise<TokenPair> {
    const user = await maybeOne<UserRow>(this.db, `select * from iam.users where username = $1`, [username]);

    if (!user) {
      await this.passwords.verifyDummy(password);
      await this.logAttempt(username, null, false, 'unknown_user');
      await this.audit.record({ action: 'auth.login_failed', entityType: 'user', entityId: null, newValue: { username, reason: 'unknown_user' }, userId: null });
      throw AppError.unauthorized('AUTH_INVALID_CREDENTIALS', 'Invalid username or password.');
    }

    if (user.locked_until && user.locked_until > new Date()) {
      // Only someone who knows the password learns that the account is locked. Anyone else gets the same answer
      // (and the same password-check delay) as for an unknown user, so a lock does not reveal which usernames exist.
      const knowsPassword = await this.passwords.verify(user.password_hash, password);
      await this.logAttempt(username, user.id, false, 'locked');
      if (!knowsPassword) throw AppError.unauthorized('AUTH_INVALID_CREDENTIALS', 'Invalid username or password.');
      const retryAfterSeconds = Math.ceil((user.locked_until.getTime() - Date.now()) / 1000);
      throw AppError.locked('AUTH_ACCOUNT_LOCKED', 'The account is temporarily locked after too many failed sign-in attempts.', { retryAfterSeconds });
    }

    const ok = await this.passwords.verify(user.password_hash, password);
    if (!ok || user.status !== 'active') {
      const reason = user.status !== 'active' ? 'inactive' : 'bad_password';
      if (user.status === 'active') {
        const maxFailed = await this.settings.get('security.max_failed_logins');
        const lockoutMinutes = await this.settings.get('security.lockout_minutes');
        const upd = await one<{ failed_login_count: number; locked_until: Date | null }>(
          this.db,
          `update iam.users
              set failed_login_count = failed_login_count + 1,
                  locked_until = case when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
            where id = $1 returning failed_login_count, locked_until`,
          [user.id, maxFailed, lockoutMinutes],
        );
        if (upd.locked_until && upd.failed_login_count >= maxFailed) {
          await this.audit.record({ action: 'auth.account_locked', entityType: 'user', entityId: user.id, newValue: { lockedUntil: upd.locked_until }, userId: user.id });
        }
      }
      await this.logAttempt(username, user.id, false, reason);
      await this.audit.record({ action: 'auth.login_failed', entityType: 'user', entityId: user.id, newValue: { reason }, userId: user.id });
      throw AppError.unauthorized('AUTH_INVALID_CREDENTIALS', 'Invalid username or password.');
    }

    return this.db.tx(async (q) => {
      await q.query(
        `update iam.users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1`,
        [user.id],
      );
      const refreshToken = this.tokens.newOpaqueToken();
      const session = await one<{ id: string }>(
        q,
        `insert into iam.sessions (user_id, refresh_token_hash, device_label, ip_address, user_agent, expires_at)
         values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id`,
        [user.id, this.tokens.hashToken(refreshToken), deviceLabel ?? null, this.meta.ip, this.meta.userAgent, this.env.REFRESH_TOKEN_TTL_DAYS],
      );
      await this.logAttempt(username, user.id, true, null, session.id, q);
      await this.audit.record({ action: 'auth.login', entityType: 'session', entityId: session.id, userId: user.id }, q);
      return this.pair(user.id, session.id, refreshToken, user.must_change_password);
    });
  }

  private async pair(userId: string, sessionId: string, refreshToken: string, mustChangePassword: boolean): Promise<TokenPair> {
    return {
      accessToken: await this.tokens.signAccess(userId, sessionId),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      mustChangePassword,
    };
  }

  /**
   * Rotates the refresh token. If a token that was already replaced is presented again, the whole
   * session is revoked: either the token was stolen or the client is broken, and in both cases
   * the safe answer is to force a new sign-in.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = this.tokens.hashToken(refreshToken);
    const outcome = await this.db.tx(async (q) => {
      const s = await maybeOne<{ id: string; user_id: string; revoked_at: Date | null; expires_at: Date; status: string; must_change_password: boolean }>(
        q,
        `select s.id, s.user_id, s.revoked_at, s.expires_at, u.status, u.must_change_password
           from iam.sessions s join iam.users u on u.id = s.user_id
          where s.refresh_token_hash = $1 for update of s`,
        [hash],
      );
      if (!s) {
        const reused = await maybeOne<{ id: string; user_id: string }>(
          q,
          `update iam.sessions set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'token_reuse')
            where previous_refresh_token_hash = $1 returning id, user_id`,
          [hash],
        );
        if (reused) {
          await this.audit.record({ action: 'auth.refresh_reuse_detected', entityType: 'session', entityId: reused.id, userId: reused.user_id }, q);
        }
        return { kind: 'invalid' as const };
      }
      if (s.revoked_at || s.expires_at <= new Date() || s.status !== 'active') return { kind: 'invalid' as const };
      const next = this.tokens.newOpaqueToken();
      await q.query(
        `update iam.sessions
            set previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = $2, last_used_at = now(),
                expires_at = now() + make_interval(days => $3)
          where id = $1`,
        [s.id, this.tokens.hashToken(next), this.env.REFRESH_TOKEN_TTL_DAYS],
      );
      return { kind: 'ok' as const, s, next };
    });
    if (outcome.kind === 'invalid') throw AppError.unauthorized('AUTH_INVALID_REFRESH', 'The refresh token is invalid or has expired. Please sign in again.');
    return this.pair(outcome.s.user_id, outcome.s.id, outcome.next, outcome.s.must_change_password);
  }

  async logout(auth: AuthContext, everywhere = false): Promise<void> {
    await this.db.tx(async (q) => {
      if (everywhere) {
        await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'logout_everywhere' where user_id = $1 and revoked_at is null`, [auth.userId]);
      } else {
        await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'logout' where id = $1 and revoked_at is null`, [auth.sessionId]);
      }
      await this.audit.record({ action: everywhere ? 'auth.logout_everywhere' : 'auth.logout', entityType: 'session', entityId: auth.sessionId }, q);
    });
  }

  async me(auth: AuthContext) {
    const u = await one(
      this.db,
      `select u.id, u.username, u.email, u.must_change_password, u.two_factor_enabled, u.last_login_at,
              e.id as employee_id, e.full_name, e.branch_id, e.job_title
         from iam.users u left join org.employees e on e.id = u.employee_id where u.id = $1`,
      [auth.userId],
    );
    const roles = await many(
      this.db,
      `select r.id, r.name, ur.branch_id from iam.user_roles ur join iam.roles r on r.id = ur.role_id where ur.user_id = $1 order by r.name`,
      [auth.userId],
    );
    const permissions = auth.permissionCodes().map((code) => {
      const s = auth.scopeFor(code);
      return { code, allBranches: s.all, branchIds: [...s.ids], exceptBranchIds: [...s.except] };
    });
    return { user: u, roles, permissions };
  }

  async listSessions(userId: string, currentSessionId?: string) {
    const rows = await many(
      this.db,
      `select id, device_label, ip_address, user_agent, created_at, last_used_at, expires_at
         from iam.sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_used_at desc`,
      [userId],
    );
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  /** A user may end their own sessions; ending someone else's needs sessions.revoke_any. */
  async revokeSession(auth: AuthContext, sessionId: string): Promise<void> {
    const s = await maybeOne<{ user_id: string }>(this.db, `select user_id from iam.sessions where id = $1`, [sessionId]);
    if (!s) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (s.user_id !== auth.userId && !auth.can('sessions.revoke_any')) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to end this session.');
    await this.db.tx(async (q) => {
      await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'revoked' where id = $1 and revoked_at is null`, [sessionId]);
      await this.audit.record({ action: 'auth.session_revoked', entityType: 'session', entityId: sessionId, newValue: { ownerId: s.user_id } }, q);
    });
  }

  async changePassword(auth: AuthContext, current: string, next: string): Promise<void> {
    const user = await one<UserRow>(this.db, `select * from iam.users where id = $1`, [auth.userId]);
    if (!(await this.passwords.verify(user.password_hash, current))) {
      throw AppError.badRequest('CURRENT_PASSWORD_INCORRECT', 'The current password is incorrect.');
    }
    if (await this.passwords.verify(user.password_hash, next)) {
      throw AppError.badRequest('PASSWORD_UNCHANGED', 'The new password must differ from the current password.');
    }
    await this.passwords.assertPolicy(next, user.username);
    const hash = await this.passwords.hash(next);
    await this.db.tx(async (q) => {
      await q.query(
        `update iam.users set password_hash = $2, must_change_password = false, password_changed_at = now(), version = version + 1 where id = $1`,
        [user.id, hash],
      );
      await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'password_changed' where user_id = $1 and id <> $2 and revoked_at is null`, [user.id, auth.sessionId]);
      await this.audit.record({ action: 'auth.password_changed', entityType: 'user', entityId: user.id }, q);
    });
  }

  /** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
  async forgotPassword(identifier: string): Promise<void> {
    const user = await maybeOne<UserRow>(
      this.db,
      `select * from iam.users where (username = $1 or email = $1) and status = 'active' and email is not null limit 1`,
      [identifier],
    );
    if (!user || !user.email) return;
    const token = this.tokens.newOpaqueToken();
    const resetTtl = await this.settings.get('security.password_reset_ttl_minutes');
    await this.db.tx(async (q) => {
      await q.query(`update iam.password_reset_tokens set used_at = now() where user_id = $1 and used_at is null`, [user.id]);
      await q.query(
        `insert into iam.password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
        [user.id, this.tokens.hashToken(token), resetTtl],
      );
      await this.audit.record({ action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, userId: user.id }, q);
    });
    await this.messaging.sendPasswordReset(user.email, user.username, token);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const hash = this.tokens.hashToken(token);
    const row = await maybeOne<{ id: string; user_id: string; username: string }>(
      this.db,
      `select t.id, t.user_id, u.username from iam.password_reset_tokens t join iam.users u on u.id = t.user_id
        where t.token_hash = $1 and t.used_at is null and t.expires_at > now() and u.status = 'active'`,
      [hash],
    );
    if (!row) throw AppError.badRequest('RESET_TOKEN_INVALID', 'The reset link is invalid or has expired.');
    await this.passwords.assertPolicy(newPassword, row.username);
    const pwHash = await this.passwords.hash(newPassword);
    await this.db.tx(async (q) => {
      const claimed = await q.query(`update iam.password_reset_tokens set used_at = now() where id = $1 and used_at is null`, [row.id]);
      if (claimed.rowCount !== 1) throw AppError.badRequest('RESET_TOKEN_INVALID', 'The reset link is invalid or has expired.');
      await q.query(
        `update iam.users set password_hash = $2, must_change_password = false, password_changed_at = now(),
                failed_login_count = 0, locked_until = null, version = version + 1 where id = $1`,
        [row.user_id, pwHash],
      );
      await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'password_reset' where user_id = $1 and revoked_at is null`, [row.user_id]);
      await this.audit.record({ action: 'auth.password_reset', entityType: 'user', entityId: row.user_id, userId: row.user_id }, q);
    });
  }
}
