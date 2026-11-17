import { resolvePeriod } from './period';

describe('resolvePeriod', () => {
  const today = '2026-11-08'; // a Sunday
  it('names whole days around the shop date', () => {
    expect(resolvePeriod(today, 'today')).toMatchObject({ from: '2026-11-08', to: '2026-11-08', days: 1 });
    expect(resolvePeriod(today, 'yesterday')).toMatchObject({ from: '2026-11-07', to: '2026-11-07' });
    expect(resolvePeriod(today, 'last_7_days')).toMatchObject({ from: '2026-11-02', to: '2026-11-08', days: 7 });
    expect(resolvePeriod(today, 'this_week')).toMatchObject({ from: '2026-11-02', to: '2026-11-08' }); // Monday start
    expect(resolvePeriod(today, 'last_week')).toMatchObject({ from: '2026-10-26', to: '2026-11-01' });
    expect(resolvePeriod(today, 'this_month')).toMatchObject({ from: '2026-11-01', to: '2026-11-08' });
    expect(resolvePeriod(today, 'last_month')).toMatchObject({ from: '2026-10-01', to: '2026-10-31', days: 31 });
    expect(resolvePeriod(today, 'this_quarter')).toMatchObject({ from: '2026-10-01', to: '2026-11-08' });
    expect(resolvePeriod(today, 'this_year')).toMatchObject({ from: '2026-01-01', to: '2026-11-08' });
  });
  it('handles January, leap days and custom ranges', () => {
    expect(resolvePeriod('2026-01-15', 'last_month')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(resolvePeriod('2028-03-01', 'last_month')).toMatchObject({ from: '2028-02-01', to: '2028-02-29', days: 29 });
    expect(resolvePeriod(today, 'custom', '2026-03-01', '2026-03-31').days).toBe(31);
  });
  it('rejects bad custom ranges', () => {
    expect(() => resolvePeriod(today, 'custom')).toThrow();
    expect(() => resolvePeriod(today, 'custom', '2026-03-31', '2026-03-01')).toThrow();
    expect(() => resolvePeriod(today, 'custom', 'nope', '2026-03-01')).toThrow();
  });
});
