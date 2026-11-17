import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ErrorBox, useToast } from '../ui/kit';

export function Login() {
  const { login } = useAuth(); const nav = useNavigate();
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false); const [sent, setSent] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await login(u.trim(), p); nav(r.mustChangePassword ? '/account' : '/', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const reset = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post('/auth/forgot-password', { identifier: u.trim() }); setSent(true); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <form onSubmit={forgot ? reset : submit} className="card rounded-lg border-slate-300 p-7 shadow-xs dark:border-slate-800 dark:bg-slate-900 space-y-4">
          <div className="text-center pb-1">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded bg-slate-900 text-white dark:bg-brand-600">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 10.5h-5.5V5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5H5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5h5.5V19c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-5.5H19c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5z" />
              </svg>
            </div>
            <h1 className="text-base font-bold uppercase tracking-wider text-slate-900 dark:text-white">Pharmacy PMS</h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {forgot ? 'Enter your username or email to get a reset link' : 'Sign in to access your dispensary'}
            </p>
          </div>
          {err ? <ErrorBox error={err} /> : null}
          {sent && <p className="rounded border border-emerald-200 bg-emerald-50 p-2.5 text-xs font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">If that account exists, a reset link has been sent.</p>}
          <div>
            <label className="label" htmlFor="u">Username{forgot ? ' or email' : ''}</label>
            <input id="u" className="input" autoFocus autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required />
          </div>
          {!forgot && (
            <div>
              <label className="label" htmlFor="p">Password</label>
              <input id="p" className="input" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required />
            </div>
          )}
          <button className="btn-primary w-full py-2 text-xs font-semibold shadow-xs" disabled={busy}>
            {busy ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Please wait…
              </span>
            ) : forgot ? 'Send reset link' : 'Sign in'}
          </button>
          <div className="text-center pt-1">
            <button
              type="button"
              className="text-xs font-medium text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400 transition-colors"
              onClick={() => { setForgot(!forgot); setErr(null); setSent(false); }}
            >
              {forgot ? '← Back to sign in' : 'Forgot password?'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Account() {
  const { me, logout, refresh } = useAuth(); const t = useToast(); const nav = useNavigate();
  const [cur, setCur] = useState(''); const [nw, setNw] = useState(''); const [err, setErr] = useState<unknown>(null);
  const must = me?.user.must_change_password;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api.post('/auth/change-password', { currentPassword: cur, newPassword: nw }); t.ok('Password changed. Please sign in again.'); await logout(); nav('/login'); refresh(); } catch (x) { setErr(x); }
  };
  return (
    <div className="mx-auto max-w-md space-y-4 pt-4">
      <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">My account</h1>
      <div className="card text-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded bg-slate-200 text-slate-700 font-bold text-sm dark:bg-slate-700 dark:text-slate-200">
            {(me?.user.full_name ?? me?.user.username ?? 'U').charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="font-bold text-slate-900 dark:text-white">{me?.user.full_name ?? me?.user.username}</div>
            <div className="text-xs text-slate-500 mt-0.5">{me?.roles.map((r) => r.name).join(', ')}</div>
          </div>
        </div>
      </div>
      {must && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">You must choose a new password before you can continue.</p>}
      <form onSubmit={submit} className="card space-y-3.5">
        <h2 className="font-bold text-xs uppercase tracking-wider text-slate-700 dark:text-slate-300">Change password</h2>
        {err ? <ErrorBox error={err} /> : null}
        <div><label className="label">Current password</label><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
        <div><label className="label">New password</label><input className="input" type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} required /></div>
        <button className="btn-primary">Change password</button>
      </form>
      <div className="pt-2">
        <button className="btn-ghost" onClick={() => void logout(true)}>Sign out of all devices</button>
      </div>
    </div>
  );
}
