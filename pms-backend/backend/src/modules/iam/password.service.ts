import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { AppError } from '../../common/app-error';
import { SettingsService } from '../platform/settings.service';

const MAX_LENGTH = 128;

@Injectable()
export class PasswordService {
  private readonly dummyHash: Promise<string>;

  constructor(private readonly settings: SettingsService) {
    this.dummyHash = argon2.hash('timing-equalisation-only', { type: argon2.argon2id });
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Spends the same time as a real check so unknown usernames are not revealed by response time. */
  async verifyDummy(password: string): Promise<void> {
    await argon2.verify(await this.dummyHash, password).catch(() => false);
  }

  /** Throws AppError(WEAK_PASSWORD) listing every rule that failed. */
  async assertPolicy(password: string, username?: string): Promise<void> {
    const minLength = await this.settings.get('security.password_min_length');
    const problems: string[] = [];
    if (password.length < minLength) problems.push(`must be at least ${minLength} characters`);
    if (password.length > MAX_LENGTH) problems.push(`must be at most ${MAX_LENGTH} characters`);
    if (!/[A-Za-z]/.test(password)) problems.push('must contain a letter');
    if (!/\d/.test(password)) problems.push('must contain a digit');
    if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push('must not contain the username');
    if (problems.length) throw AppError.badRequest('WEAK_PASSWORD', 'The password does not meet the password policy.', problems);
  }

  /** One-time password shown once to an administrator; the user must change it at first login. */
  async generateTemporary(): Promise<string> {
    const minLength = await this.settings.get('security.password_min_length');
    const pick = (chars: string) => chars[randomInt(chars.length)];
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnopqrstuvwxyz', digits = '23456789';
    const all = upper + lower + digits;
    const chars = [pick(upper), pick(lower), pick(digits)];
    while (chars.length < Math.max(14, minLength + 2)) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
