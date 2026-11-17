import { ADMIN, authed, createTestApp, GOOD_PASSWORD, login, makeAdmin, TestCtx, tokenFor } from './helpers';

describe('Authentication', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => { await ctx.reset(); await makeAdmin(ctx); });

  it('rejects requests without a token and with a tampered token', async () => {
    expect((await ctx.http().get('/api/v1/auth/me')).status).toBe(401);
    const token = await tokenFor(ctx, ADMIN.username, ADMIN.password);
    const tampered = token.slice(0, -4) + 'AAAA';
    expect((await authed(ctx, tampered).get('/auth/me')).status).toBe(401);
    expect((await ctx.http().get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);
  });

  it('signs in, returns the profile and records history and audit entries', async () => {
    const res = await login(ctx, ADMIN.username, ADMIN.password);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer', mustChangePassword: false });
    expect(res.body.refreshToken.length).toBeGreaterThan(40);

    const me = await authed(ctx, res.body.accessToken).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('admin');
    expect(me.body.roles.map((r: any) => r.name)).toContain('System Administrator');
    expect(me.body.permissions.length).toBeGreaterThan(10);

    const hist = await ctx.db.query(`select success from iam.login_history where username_attempted = 'admin'`);
    expect(hist.rows).toEqual([{ success: true }]);
    const audit = await ctx.db.query(`select 1 from audit.audit_logs where action = 'auth.login'`);
    expect(audit.rowCount).toBe(1);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const wrong = await login(ctx, ADMIN.username, 'Wrong-Passw0rd!');
    const unknown = await login(ctx, 'nobody', 'Wrong-Passw0rd!');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(unknown.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(wrong.body.message).toBe(unknown.body.message);
    const hist = await ctx.db.query(`select failure_reason from iam.login_history order by attempted_at`);
    expect(hist.rows.map((r) => r.failure_reason)).toEqual(['bad_password', 'unknown_user']);
  });

  it('locks the account after repeated failures and unlocks when the lock expires', async () => {
    for (let i = 0; i < 3; i++) expect((await login(ctx, ADMIN.username, 'Wrong-Passw0rd!')).status).toBe(401);
    // A wrong password on a locked account looks exactly like an unknown user, so the lock does not reveal the username exists.
    const lockedWrong = await login(ctx, ADMIN.username, 'Wrong-Passw0rd!');
    expect(lockedWrong.status).toBe(401);
    expect(lockedWrong.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(lockedWrong.body.code).toBe((await login(ctx, 'no.such.user', 'Wrong-Passw0rd!')).body.code);
    const locked = await login(ctx, ADMIN.username, ADMIN.password);
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(locked.body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'auth.account_locked'`)).rowCount).toBe(1);

    await ctx.db.query(`update iam.users set locked_until = now() - interval '1 minute' where username = 'admin'`);
    expect((await login(ctx, ADMIN.username, ADMIN.password)).status).toBe(200);
    expect((await ctx.db.query(`select failed_login_count from iam.users where username = 'admin'`)).rows[0].failed_login_count).toBe(0);
  });

  it('rotates refresh tokens and revokes the session if an old token is replayed', async () => {
    const first = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    const second = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    expect((await authed(ctx, second.body.accessToken).get('/auth/me')).status).toBe(200);

    const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    // the whole session is now dead, including the newest token and its access token
    expect((await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: second.body.refreshToken })).status).toBe(401);
    expect((await authed(ctx, second.body.accessToken).get('/auth/me')).status).toBe(401);
    expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'auth.refresh_reuse_detected'`)).rowCount).toBe(1);
  });

  it('stores only hashes of refresh tokens', async () => {
    const t = (await login(ctx, ADMIN.username, ADMIN.password)).body.refreshToken;
    const rows = await ctx.db.query(`select refresh_token_hash from iam.sessions`);
    expect(rows.rows[0].refresh_token_hash).not.toBe(t);
    expect(rows.rows[0].refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logout ends the session immediately; logout everywhere ends all sessions', async () => {
    const a = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    const b = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    expect((await authed(ctx, a.accessToken).post('/auth/logout')).status).toBe(204);
    expect((await authed(ctx, a.accessToken).get('/auth/me')).status).toBe(401);
    expect((await authed(ctx, b.accessToken).get('/auth/me')).status).toBe(200);
    expect((await authed(ctx, b.accessToken).post('/auth/logout', { everywhere: true })).status).toBe(204);
    expect((await authed(ctx, b.accessToken).get('/auth/me')).status).toBe(401);
  });

  it('lists own sessions and lets a user end another of their own sessions', async () => {
    const a = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    const b = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    const list = await authed(ctx, a.accessToken).get('/auth/sessions');
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: any) => !s.current);
    expect((await authed(ctx, a.accessToken).del(`/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await authed(ctx, b.accessToken).get('/auth/me')).status).toBe(401);
  });

  it('forces a password change before anything else, then ends other sessions', async () => {
    await ctx.db.query(`update iam.users set must_change_password = true`);
    const first = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    const other = (await login(ctx, ADMIN.username, ADMIN.password)).body;
    expect(first.mustChangePassword).toBe(true);
    const api = authed(ctx, first.accessToken);
    const blocked = await api.get('/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await api.get('/auth/me')).status).toBe(200);

    const weak = await api.post('/auth/change-password', { currentPassword: ADMIN.password, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('WEAK_PASSWORD');
    const same = await api.post('/auth/change-password', { currentPassword: ADMIN.password, newPassword: ADMIN.password });
    expect(same.body.code).toBe('PASSWORD_UNCHANGED');
    const badCurrent = await api.post('/auth/change-password', { currentPassword: 'Nope-Passw0rd!', newPassword: GOOD_PASSWORD });
    expect(badCurrent.body.code).toBe('CURRENT_PASSWORD_INCORRECT');

    expect((await api.post('/auth/change-password', { currentPassword: ADMIN.password, newPassword: GOOD_PASSWORD })).status).toBe(204);
    expect((await api.get('/users')).status).toBe(200);
    expect((await authed(ctx, other.accessToken).get('/auth/me')).status).toBe(401);
    expect((await login(ctx, ADMIN.username, ADMIN.password)).status).toBe(401);
    expect((await login(ctx, ADMIN.username, GOOD_PASSWORD)).status).toBe(200);
  });

  it('supports forgot and reset password without revealing which accounts exist', async () => {
    await ctx.db.query(`update iam.users set email = 'admin@example.test' where username = 'admin'`);
    const session = (await login(ctx, ADMIN.username, ADMIN.password)).body;

    const unknown = await ctx.http().post('/api/v1/auth/forgot-password').send({ identifier: 'ghost@example.test' });
    const known = await ctx.http().post('/api/v1/auth/forgot-password').send({ identifier: 'admin@example.test' });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(ctx.messaging.outbox).toHaveLength(1);

    const token = ctx.messaging.outbox[0].token!;
    const stored = await ctx.db.query(`select token_hash from iam.password_reset_tokens`);
    expect(stored.rows[0].token_hash).not.toBe(token);

    expect((await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'weak' })).status).toBe(400);
    expect((await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: GOOD_PASSWORD })).status).toBe(204);
    // single use
    expect((await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'An0ther-Passw0rd!' })).status).toBe(400);
    // old sessions die, old password dies
    expect((await authed(ctx, session.accessToken).get('/auth/me')).status).toBe(401);
    expect((await login(ctx, ADMIN.username, ADMIN.password)).status).toBe(401);
    expect((await login(ctx, ADMIN.username, GOOD_PASSWORD)).status).toBe(200);
  });

  it('rejects expired reset tokens', async () => {
    await ctx.db.query(`update iam.users set email = 'admin@example.test'`);
    await ctx.http().post('/api/v1/auth/forgot-password').send({ identifier: 'admin' });
    await ctx.db.query(`update iam.password_reset_tokens set expires_at = now() - interval '1 minute'`);
    const res = await ctx.http().post('/api/v1/auth/reset-password').send({ token: ctx.messaging.outbox[0].token, newPassword: GOOD_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RESET_TOKEN_INVALID');
  });

  it('stops an already-issued access token when the user is deactivated', async () => {
    const admin = await tokenFor(ctx, ADMIN.username, ADMIN.password);
    const created = await authed(ctx, admin).post('/users', { username: 'temp.user', password: GOOD_PASSWORD });
    expect(created.status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = 'temp.user'`);
    const userToken = await tokenFor(ctx, 'temp.user', GOOD_PASSWORD);
    expect((await authed(ctx, userToken).get('/auth/me')).status).toBe(200);
    expect((await authed(ctx, admin).post(`/users/${created.body.id}/deactivate`, { version: created.body.version })).status).toBe(200);
    expect((await authed(ctx, userToken).get('/auth/me')).status).toBe(401);
    expect((await login(ctx, 'temp.user', GOOD_PASSWORD)).status).toBe(401);
  });

  it('rejects unknown fields and malformed input', async () => {
    const res = await ctx.http().post('/api/v1/auth/login').send({ username: 'admin', password: 'x', isAdmin: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await ctx.http().post('/api/v1/auth/login').send({})).status).toBe(400);
  });

  it('answers health checks without authentication', async () => {
    expect((await ctx.http().get('/api/v1/health/live')).status).toBe(200);
    const ready = await ctx.http().get('/api/v1/health/ready');
    expect(ready.body).toEqual({ status: 'ok', database: 'up' });
  });
});
