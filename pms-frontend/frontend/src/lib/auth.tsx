import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setSignedOutHandler, tokens } from './api';

export interface Me {
  user: { id: string; username: string; email: string | null; must_change_password: boolean; full_name: string | null; branch_id: string | null; job_title: string | null };
  roles: Array<{ id: string; name: string; branch_id: string | null }>;
  permissions: Array<{ code: string; allBranches: boolean; branchIds: string[]; exceptBranchIds: string[] }>;
}
interface AuthState {
  me: Me | null; loading: boolean;
  login(username: string, password: string): Promise<{ mustChangePassword: boolean }>;
  logout(everywhere?: boolean): Promise<void>;
  /** can the person do this, at that branch (or anywhere when no branch is given) */
  can(code: string, branchId?: string | null): boolean;
  /** branches this permission covers; null means all of them */
  branchesFor(code: string): string[] | null;
  refresh(): void;
}
const Ctx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [signedIn, setSignedIn] = useState(!!tokens.refresh);
  const q = useQuery({
    queryKey: ['me'], enabled: signedIn, retry: false, staleTime: 60_000,
    // A tablet restarted without a connection keeps working from the last known profile; the server still checks every request.
    queryFn: async () => {
      try { const m = await api.get<Me>('/auth/me'); try { localStorage.setItem('pms.me', JSON.stringify(m)); } catch { /* storage full or blocked */ } return m; } catch (e) {
        if (e instanceof ApiError && e.network) { try { const c = localStorage.getItem('pms.me'); if (c) return JSON.parse(c) as Me; } catch { /* unreadable */ } }
        throw e;
      }
    },
  });
  useEffect(() => { setSignedOutHandler(() => { qc.clear(); setSignedIn(false); try { localStorage.removeItem('pms.me'); } catch { /* ignore */ } }); }, [qc]);
  useEffect(() => { if (q.error instanceof ApiError && q.error.status === 401) setSignedIn(false); }, [q.error]);

  const perms = useMemo(() => new Map((q.data?.permissions ?? []).map((p) => [p.code, p])), [q.data]);
  const can = useCallback((code: string, branchId?: string | null) => {
    const p = perms.get(code);
    if (!p) return false;
    if (!branchId) return true;
    if (p.exceptBranchIds.includes(branchId)) return false;
    return p.allBranches || p.branchIds.includes(branchId);
  }, [perms]);
  const branchesFor = useCallback((code: string) => { const p = perms.get(code); return !p ? [] : p.allBranches ? null : p.branchIds; }, [perms]);

  const value: AuthState = {
    me: signedIn ? q.data ?? null : null, loading: signedIn && q.isLoading, can, branchesFor,
    refresh: () => { void qc.invalidateQueries({ queryKey: ['me'] }); },
    async login(username, password) {
      const r = await api.post('/auth/login', { username, password, deviceLabel: navigator.userAgent.slice(0, 80) });
      tokens.set(r.accessToken, r.refreshToken);
      setSignedIn(true);
      await qc.invalidateQueries({ queryKey: ['me'] });
      return { mustChangePassword: !!r.mustChangePassword };
    },
    async logout(everywhere = false) {
      try { await api.post('/auth/logout', { everywhere }); } catch { /* already signed out */ }
      tokens.clear(); qc.clear(); setSignedIn(false); try { localStorage.removeItem('pms.me'); } catch { /* ignore */ }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The branch the person is working in. Remembered per browser. */
interface BranchState { branchId: string | null; setBranchId(id: string | null): void }
const BCtx = createContext<BranchState>(null as never);
export const useBranch = () => useContext(BCtx);
export function BranchProvider({ children }: { children: ReactNode }) {
  const [branchId, set] = useState<string | null>(() => localStorage.getItem('pms.branch'));
  const setBranchId = (id: string | null) => { if (id) localStorage.setItem('pms.branch', id); else localStorage.removeItem('pms.branch'); set(id); };
  return <BCtx.Provider value={{ branchId, setBranchId }}>{children}</BCtx.Provider>;
}
