import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { ENV, Env } from '../../config/env';

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  signAccess(userId: string, sessionId: string): Promise<string> {
    const claims: AccessClaims = { sub: userId, sid: sessionId, typ: 'access' };
    return this.jwt.signAsync(claims, { expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS });
  }

  /** Returns null for any invalid, expired, or wrongly typed token. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<AccessClaims>(token, { algorithms: ['HS256'] });
      return claims.typ === 'access' && claims.sub && claims.sid ? claims : null;
    } catch {
      return null;
    }
  }

  newOpaqueToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /** Only the hash is stored, so a database leak does not expose usable tokens. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  get accessTtlSeconds() { return this.env.ACCESS_TOKEN_TTL_SECONDS; }
}
