import { Scope } from './scope';

describe('Scope', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';

  it('unrestricted scope includes every branch and branch-less records', () => {
    const s = Scope.everything();
    expect(s.includes(A)).toBe(true);
    expect(s.includes(null)).toBe(true);
    expect(s.isUnrestricted).toBe(true);
  });

  it('branch scope includes only listed branches and excludes branch-less records', () => {
    const s = new Scope(false, new Set([A]));
    expect(s.includes(A)).toBe(true);
    expect(s.includes(B)).toBe(false);
    expect(s.includes(null)).toBe(false);
    expect(s.isUnrestricted).toBe(false);
  });

  it('all-except scope excludes the denied branches', () => {
    const s = new Scope(true, new Set(), new Set([B]));
    expect(s.includes(A)).toBe(true);
    expect(s.includes(B)).toBe(false);
    expect(s.includes(null)).toBe(false);
  });

  it('none scope includes nothing', () => {
    expect(Scope.none().includes(A)).toBe(false);
    expect(Scope.none().isEmpty).toBe(true);
  });

  it('builds SQL conditions with bound parameters, never inline values', () => {
    const p1: unknown[] = [];
    expect(Scope.everything().sql('e.branch_id', p1)).toBe('true');
    expect(p1).toHaveLength(0);

    const p2: unknown[] = [];
    expect(Scope.none().sql('e.branch_id', p2)).toBe('false');

    const p3: unknown[] = ['x'];
    expect(new Scope(false, new Set([A])).sql('e.branch_id', p3)).toBe('e.branch_id = any($2::uuid[])');
    expect(p3[1]).toEqual([A]);

    const p4: unknown[] = [];
    expect(new Scope(true, new Set(), new Set([B])).sql('b.id', p4)).toBe('(b.id is not null and b.id <> all($1::uuid[]))');
    expect(p4[0]).toEqual([B]);
  });
});
