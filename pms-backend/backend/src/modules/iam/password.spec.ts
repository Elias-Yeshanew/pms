import { PasswordService } from './password.service';
const settings = { get: async (key: string) => (key === 'security.password_min_length' ? 10 : undefined) } as any;
const svc = new PasswordService(settings);

describe('PasswordService', () => {
  it('hashes and verifies passwords, rejecting wrong ones', async () => {
    const h = await svc.hash('Correct-Horse-9');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'Correct-Horse-9')).toBe(true);
    expect(await svc.verify(h, 'wrong-Horse-9')).toBe(false);
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });

  it('enforces the policy and lists every failed rule', async () => {
    await expect(svc.assertPolicy('Str0ngEnough1', 'alice')).resolves.toBeUndefined();
    for (const bad of ['short1', 'onlyletterslong', '1234567890123', 'xxALICExx123456']) {
      await expect(svc.assertPolicy(bad, 'alice')).rejects.toBeDefined();
    }
    const err: any = await svc.assertPolicy('abc', 'abc').catch((e) => e);
    expect(err.code).toBe('WEAK_PASSWORD');
    expect(err.details.length).toBeGreaterThanOrEqual(3);
  });

  it('generates temporary passwords that satisfy the policy and are different each time', async () => {
    const a = await svc.generateTemporary(), b = await svc.generateTemporary();
    expect(a).not.toEqual(b);
    await expect(svc.assertPolicy(a, 'someone')).resolves.toBeUndefined();
  });
});
