import type { Request } from 'express';
import { Scope } from './scope';

export interface AuthContext {
  userId: string;
  sessionId: string;
  username: string;
  mustChangePassword: boolean;
  /** Scope for a permission code; empty scope means the user does not hold it. */
  scopeFor(code: string): Scope;
  can(code: string, branchId?: string | null): boolean;
  permissionCodes(): string[];
}

export type AuthedRequest = Request & { auth: AuthContext };
