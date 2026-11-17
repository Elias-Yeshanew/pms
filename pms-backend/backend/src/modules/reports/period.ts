import { AppError } from '../../common/app-error';

export const PRESETS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'this_year', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];
export interface Period { preset: Preset; from: string; to: string; days: number }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);

/**
 * Turns a name like "this_month" (or a custom from/to) into whole calendar days, both ends included.
 * `today` is the shop's own date, so "today" means the pharmacy's day, not the server's. Weeks start on Monday.
 */
export function resolvePeriod(today: string, preset: Preset = 'this_month', from?: string, to?: string): Period {
  const t = utc(today);
  let a: Date, b: Date;
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  switch (preset) {
    case 'today': a = b = t; break;
    case 'yesterday': a = b = addDays(t, -1); break;
    case 'last_7_days': a = addDays(t, -6); b = t; break;
    case 'last_30_days': a = addDays(t, -29); b = t; break;
    case 'this_week': a = addDays(t, -dow); b = t; break;
    case 'last_week': a = addDays(t, -dow - 7); b = addDays(t, -dow - 1); break;
    case 'this_month': a = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)); b = t; break;
    case 'last_month': a = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)); b = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)); break;
    case 'this_quarter': a = new Date(Date.UTC(t.getUTCFullYear(), Math.floor(t.getUTCMonth() / 3) * 3, 1)); b = t; break;
    case 'this_year': a = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); b = t; break;
    case 'custom': {
      if (!from || !to) throw AppError.badRequest('PERIOD_REQUIRED', 'A custom period needs both from and to dates.');
      a = utc(from); b = utc(to);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw AppError.badRequest('INVALID_PERIOD', 'Dates must look like 2026-03-31.');
      if (b < a) throw AppError.badRequest('INVALID_PERIOD', 'The end date is before the start date.');
      if ((b.getTime() - a.getTime()) / 864e5 > 3660) throw AppError.badRequest('PERIOD_TOO_LONG', 'Choose a period of at most 10 years.');
      break;
    }
    default: throw AppError.badRequest('INVALID_PERIOD', `Unknown period "${preset as string}".`, { presets: PRESETS });
  }
  return { preset, from: iso(a), to: iso(b), days: Math.round((b.getTime() - a.getTime()) / 864e5) + 1 };
}
