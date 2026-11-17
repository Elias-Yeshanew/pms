import { computeScopes } from './permission.service';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const g = (code: string, branch_id: string | null, effect: 'allow' | 'deny' = 'allow') => ({ code, branch_id, effect });

describe('computeScopes', () => {
  it('company-wide allow gives unrestricted scope', () => {
    expect(computeScopes([g('users.read', null)]).get('users.read')?.isUnrestricted).toBe(true);
  });

  it('branch-level allows combine across roles', () => {
    const s = computeScopes([g('users.read', A), g('users.read', B)]).get('users.read')!;
    expect(s.includes(A) && s.includes(B)).toBe(true);
    expect(s.all).toBe(false);
  });

  it('a company-wide deny removes the permission entirely, even if a role grants it', () => {
    expect(computeScopes([g('users.read', null), g('users.read', null, 'deny')]).has('users.read')).toBe(false);
  });

  it('a branch deny carves that branch out of a company-wide allow', () => {
    const s = computeScopes([g('users.read', null), g('users.read', B, 'deny')]).get('users.read')!;
    expect(s.includes(A)).toBe(true);
    expect(s.includes(B)).toBe(false);
    expect(s.isUnrestricted).toBe(false);
  });

  it('a branch deny removes that branch from a branch-level allow', () => {
    const s = computeScopes([g('users.read', A), g('users.read', B), g('users.read', B, 'deny')]).get('users.read')!;
    expect(s.includes(A)).toBe(true);
    expect(s.includes(B)).toBe(false);
  });

  it('denying the only allowed branch leaves no permission', () => {
    expect(computeScopes([g('users.read', A), g('users.read', A, 'deny')]).has('users.read')).toBe(false);
  });

  it('keeps permissions independent of each other', () => {
    const m = computeScopes([g('users.read', null), g('roles.manage', A)]);
    expect(m.get('users.read')?.isUnrestricted).toBe(true);
    expect(m.get('roles.manage')?.includes(A)).toBe(true);
  });
});
