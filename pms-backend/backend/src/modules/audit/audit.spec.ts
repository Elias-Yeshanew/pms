import { redact } from './audit.service';

describe('audit redaction', () => {
  it('removes secrets at any depth', () => {
    const out = redact({ username: 'a', password: 'x', nested: { refreshToken: 'y', password_hash: 'z', ok: 1 }, list: [{ secret: 's', n: 2 }] });
    expect(out).toEqual({ username: 'a', password: '[redacted]', nested: { refreshToken: '[redacted]', password_hash: '[redacted]', ok: 1 }, list: [{ secret: '[redacted]', n: 2 }] });
  });
});
