import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

describe('Users, roles, branches and branch scope', () => {
  let ctx: TestCtx;
  let admin: ReturnType<typeof authed>;
  let branchA: any, branchB: any, empA: any, empB: any;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  beforeEach(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    branchA = (await admin.post('/branches', { code: 'MAIN', name: 'Main Dispenser', isCentral: true })).body;
    branchB = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa Dispenser' })).body;
    empA = (await admin.post('/employees', { branchId: branchA.id, fullName: 'Abel Tesfaye' })).body;
    empB = (await admin.post('/employees', { branchId: branchB.id, fullName: 'Bethlehem Alemu' })).body;
  });

  /** Creates a user, clears the first-login flag and returns an authed client. */
  async function userWith(username: string, employeeId: string | null, roles: Array<{ roleId: string; branchId?: string }>) {
    const res = await admin.post('/users', { username, password: GOOD_PASSWORD, employeeId: employeeId ?? undefined, roles });
    expect(res.status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return { id: res.body.id as string, api: authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD)) };
  }

  async function managerRole(): Promise<string> {
    const res = await admin.post('/roles', {
      name: 'Branch User Admin', description: 'test',
      permissions: ['users.read', 'users.create', 'users.update', 'users.assign_roles', 'employees.read', 'employees.manage', 'branches.read', 'branches.manage'],
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('creates branches and employees, rejects duplicates and bad codes', async () => {
    expect(branchA.code).toBe('MAIN');
    const dup = await admin.post('/branches', { code: 'MAIN', name: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_VALUE');
    expect((await admin.post('/branches', { code: 'bad code', name: 'x' })).status).toBe(400);
    expect((await admin.post('/employees', { branchId: '00000000-0000-4000-8000-000000000000', fullName: 'Ghost' })).status).toBe(400);
  });

  it('generates a one-time password when none is given, and the user must change it', async () => {
    const res = await admin.post('/users', { username: 'new.hire', employeeId: empA.id });
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeDefined();
    expect(res.body.must_change_password).toBe(true);
    const login = await ctx.http().post('/api/v1/auth/login').send({ username: 'new.hire', password: res.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    const again = await admin.get(`/users/${res.body.id}`);
    expect(again.body.temporaryPassword).toBeUndefined();
  });

  it('hides users and employees of other branches from a branch-scoped manager', async () => {
    const mgr = await roleId(ctx, 'Branch Manager');
    await userWith('mgr.a', empA.id, [{ roleId: mgr, branchId: branchA.id }]);
    await admin.post('/users', { username: 'staff.b', password: GOOD_PASSWORD, employeeId: empB.id });
    const staffA = await admin.post('/users', { username: 'staff.a', password: GOOD_PASSWORD });
    expect(staffA.status).toBe(201);

    const a = authed(ctx, await tokenFor(ctx, 'mgr.a', GOOD_PASSWORD));
    const list = await a.get('/users');
    expect(list.status).toBe(200);
    expect(list.body.items.map((u: any) => u.username)).toEqual(['mgr.a']);
    expect(list.body.items.every((u: any) => u.branch_id === branchA.id)).toBe(true);

    const staffB = (await admin.get('/users?search=staff.b')).body.items[0];
    expect((await a.get(`/users/${staffB.id}`)).status).toBe(404);
    expect((await a.get(`/users/${staffA.body.id}`)).status).toBe(404); // company-level user (no branch)
    expect((await a.get(`/employees/${empB.id}`)).status).toBe(404);
    expect((await a.get(`/employees?branchId=${branchB.id}`)).body.items).toHaveLength(0);
    expect((await a.get(`/branches/${branchB.id}`)).status).toBe(404);
    expect((await a.get('/branches')).body.items.map((b: any) => b.code)).toEqual(['MAIN']);
  });

  it('lets a branch-scoped manager act only inside their branch', async () => {
    const role = await managerRole();
    const mgr = await userWith('mgr.a', empA.id, [{ roleId: role, branchId: branchA.id }]);
    const extraA = (await admin.post('/employees', { branchId: branchA.id, fullName: 'Extra A' })).body;

    expect((await mgr.api.post('/users', { username: 'cashier.a', password: GOOD_PASSWORD, employeeId: extraA.id })).status).toBe(201);
    const denied = await mgr.api.post('/users', { username: 'cashier.b', password: GOOD_PASSWORD, employeeId: empB.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('OUT_OF_SCOPE');
    // a company-level user (no employee) is outside a branch manager's reach
    expect((await mgr.api.post('/users', { username: 'floating', password: GOOD_PASSWORD })).status).toBe(403);

    expect((await mgr.api.post('/employees', { branchId: branchA.id, fullName: 'New A' })).status).toBe(201);
    expect((await mgr.api.post('/employees', { branchId: branchB.id, fullName: 'New B' })).status).toBe(403);
    // moving an employee into another branch is refused
    expect((await mgr.api.patch(`/employees/${extraA.id}`, { version: extraA.version, branchId: branchB.id })).status).toBe(403);

    expect((await mgr.api.patch(`/branches/${branchA.id}`, { version: branchA.version, phone: '0111' })).status).toBe(200);
    expect((await mgr.api.patch(`/branches/${branchB.id}`, { version: branchB.version, phone: '0222' })).status).toBe(404);
    // creating a branch changes the company structure: needs company-wide access
    expect((await mgr.api.post('/branches', { code: 'NEW', name: 'New' })).status).toBe(403);
  });

  it('prevents privilege escalation when assigning roles', async () => {
    const role = await managerRole();
    const mgr = await userWith('mgr.a', empA.id, [{ roleId: role, branchId: branchA.id }]);
    const extraA = (await admin.post('/employees', { branchId: branchA.id, fullName: 'Extra A' })).body;
    const target = (await admin.post('/users', { username: 'target.a', password: GOOD_PASSWORD, employeeId: extraA.id })).body;
    const sysAdmin = await roleId(ctx, 'System Administrator');
    // a lower role made only of permissions the manager holds (the built-in Cashier also has registers.read, which they lack)
    const cashier = (await admin.post('/roles', { name: 'Counter Reader', permissions: ['branches.read'] })).body.id;
    const cashierBuiltIn = await roleId(ctx, 'Cashier');

    const esc = await mgr.api.put(`/users/${target.id}/roles`, { roles: [{ roleId: sysAdmin, branchId: branchA.id }] });
    expect(esc.status).toBe(403);
    expect(esc.body.code).toBe('ROLE_EXCEEDS_YOUR_ACCESS');
    // a role the manager holds only for branch A cannot be handed out company-wide
    const wide = await mgr.api.put(`/users/${target.id}/roles`, { roles: [{ roleId: cashier }] });
    expect(wide.status).toBe(403);
    // the built-in Cashier role contains a permission the manager does not hold, so it is refused too
    const tooMuch = await mgr.api.put(`/users/${target.id}/roles`, { roles: [{ roleId: cashierBuiltIn, branchId: branchA.id }] });
    expect(tooMuch.body.code).toBe('ROLE_EXCEEDS_YOUR_ACCESS');
    // in their own branch, a lower role is fine
    const ok = await mgr.api.put(`/users/${target.id}/roles`, { roles: [{ roleId: cashier, branchId: branchA.id }] });
    expect(ok.status).toBe(200);
    expect(ok.body.roles).toHaveLength(1);
    // and the manager cannot create a role containing permissions they do not hold company-wide
    expect((await mgr.api.post('/roles', { name: 'X', permissions: ['users.read'] })).status).toBe(403);
    // taking a powerful role away from someone is equally restricted
    await admin.put(`/users/${target.id}/roles`, { roles: [{ roleId: sysAdmin }, { roleId: cashier, branchId: branchA.id }] });
    const take = await mgr.api.put(`/users/${target.id}/roles`, { roles: [{ roleId: cashier, branchId: branchA.id }] });
    expect(take.status).toBe(403);
    expect(take.body.code).toBe('ROLE_EXCEEDS_YOUR_ACCESS');
    expect((await admin.get(`/users/${target.id}`)).body.roles).toHaveLength(2);
  });

  it('always keeps at least one active company-wide System Administrator', async () => {
    const adminId = (await admin.get('/auth/me')).body.user.id;
    expect((await admin.post(`/users/${adminId}/deactivate`, { version: 1 })).body.code).toBe('CANNOT_DEACTIVATE_SELF');

    const sysAdmin = await roleId(ctx, 'System Administrator');
    const allCodes = (await admin.get('/permissions')).body.map((p: any) => p.code);
    const full = (await admin.post('/roles', { name: 'Full Access', permissions: allCodes })).body;
    const second = await userWith('admin2', null, [{ roleId: sysAdmin }]);
    const helper = await userWith('helper', null, [{ roleId: full.id }]); // all permissions, but not the System Administrator role

    // the second admin may deactivate the first: one admin remains
    const ver = (await admin.get(`/users/${adminId}`)).body.version;
    expect((await second.api.post(`/users/${adminId}/deactivate`, { version: ver })).status).toBe(200);

    // now admin2 is the last one: neither deactivating them nor removing their role may succeed
    const secondVer = (await helper.api.get(`/users/${second.id}`)).body.version;
    const deact = await helper.api.post(`/users/${second.id}/deactivate`, { version: secondVer });
    expect(deact.status).toBe(409);
    expect(deact.body.code).toBe('LAST_ADMIN');
    const strip = await helper.api.put(`/users/${second.id}/roles`, { roles: [] });
    expect(strip.status).toBe(409);
    expect(strip.body.code).toBe('LAST_ADMIN');

    // nothing was changed by the refused attempts
    const after = (await helper.api.get(`/users/${second.id}`)).body;
    expect(after.status).toBe('active');
    expect(after.roles.map((r: any) => r.name)).toEqual(['System Administrator']);
  });

  it('detects conflicting edits with optimistic concurrency', async () => {
    const u = (await admin.post('/users', { username: 'edit.me', password: GOOD_PASSWORD, email: 'a@example.test' })).body;
    expect((await admin.patch(`/users/${u.id}`, { version: u.version, email: 'b@example.test' })).status).toBe(200);
    const stale = await admin.patch(`/users/${u.id}`, { version: u.version, email: 'c@example.test' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await admin.get(`/users/${u.id}`)).body.email).toBe('b@example.test');
  });

  it('applies role permission changes immediately and audits them', async () => {
    const role = (await admin.post('/roles', { name: 'Reader', permissions: ['branches.read'] })).body;
    const u = await userWith('reader', null, [{ roleId: role.id }]);
    expect((await u.api.get('/employees')).status).toBe(403);
    const upd = await admin.put(`/roles/${role.id}/permissions`, { version: role.version, permissions: ['branches.read', 'employees.read'] });
    expect(upd.status).toBe(200);
    expect((await u.api.get('/employees')).status).toBe(200);
    expect((await admin.put(`/roles/${role.id}/permissions`, { version: role.version, permissions: [] })).status).toBe(409);
    expect((await admin.put(`/roles/${role.id}/permissions`, { version: upd.body.version, permissions: ['no.such_perm'] })).body.code).toBe('UNKNOWN_PERMISSION');
    const rows = await ctx.db.query(`select 1 from audit.audit_logs where action = 'role.permissions_changed' and entity_id = $1`, [role.id]);
    expect(rows.rowCount).toBe(1);
  });

  it('does not allow renaming built-in roles', async () => {
    const r = (await admin.get(`/roles/${await roleId(ctx, 'Cashier')}`)).body;
    const res = await admin.patch(`/roles/${r.id}`, { version: r.version, name: 'Till Operator' });
    expect(res.body.code).toBe('SYSTEM_ROLE_NAME_LOCKED');
  });

  it('resets a password for an admin action: temporary password, forced change, sessions ended', async () => {
    const u = await userWith('forgetful', null, []);
    const res = await admin.post(`/users/${u.id}/reset-password`);
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toBeDefined();
    expect((await u.api.get('/auth/me')).status).toBe(401);
    const login = await ctx.http().post('/api/v1/auth/login').send({ username: 'forgetful', password: res.body.temporaryPassword });
    expect(login.body.mustChangePassword).toBe(true);
    const adminId = (await admin.get('/auth/me')).body.user.id;
    expect((await admin.post(`/users/${adminId}/reset-password`)).body.code).toBe('USE_CHANGE_PASSWORD');
  });

  it('shows sign-in history and refuses it to users without the permission', async () => {
    const u = await userWith('watched', null, []);
    await ctx.http().post('/api/v1/auth/login').send({ username: 'watched', password: 'Wrong-Passw0rd!' });
    const hist = await admin.get(`/users/${u.id}/login-history`);
    expect(hist.status).toBe(200);
    expect(hist.body.items.map((h: any) => h.success)).toEqual([false, true]);
    expect((await u.api.get(`/users/${u.id}/login-history`)).status).toBe(403);
  });

  it('records attributable, secret-free audit entries and keeps the log append-only', async () => {
    await admin.post('/users', { username: 'audited', password: GOOD_PASSWORD, email: 'x@example.test' });
    const logs = await admin.get('/audit-logs?action=user.created');
    expect(logs.status).toBe(200);
    expect(logs.body.total).toBe(1);
    const entry = logs.body.items[0];
    expect(entry.username).toBe('admin');
    expect(entry.request_id).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(GOOD_PASSWORD);

    await expect(ctx.db.query(`update audit.audit_logs set action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`delete from audit.audit_logs`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`delete from iam.login_history`)).rejects.toThrow(/append-only/);
  });

  it('restricts the audit log to users with audit.read, within their branch scope', async () => {
    const auditor = await roleId(ctx, 'Auditor');
    const scoped = await userWith('auditor.a', empA.id, [{ roleId: auditor, branchId: branchA.id }]);
    const nobody = await userWith('nobody', null, []);
    expect((await nobody.api.get('/audit-logs')).status).toBe(403);
    const res = await scoped.api.get('/audit-logs?pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((e: any) => e.branch_id === branchA.id)).toBe(true);
  });

  it('refuses permission-less access with 403 and unknown ids with 404', async () => {
    const nobody = await userWith('nobody', null, []);
    expect((await nobody.api.get('/users')).status).toBe(403);
    expect((await nobody.api.get('/roles')).status).toBe(403);
    expect((await admin.get('/users/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await admin.get('/users/not-a-uuid')).status).toBe(400);
  });

  it('rolls back everything when part of a multi-step change fails', async () => {
    const res = await admin.post('/users', {
      username: 'half.done', password: GOOD_PASSWORD,
      roles: [{ roleId: await roleId(ctx, 'Cashier') }, { roleId: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(res.status).toBe(400);
    expect((await ctx.db.query(`select 1 from iam.users where username = 'half.done'`)).rowCount).toBe(0);
    expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'user.created' and new_value->>'username' = 'half.done'`)).rowCount).toBe(0);
  });
});
