/**
 * Exact decimal arithmetic on strings, backed by BigInt. Money and quantities never touch
 * floating point, so 0.1 + 0.2 is 0.3 and rounding is always an explicit, named rule.
 * All values carry 4 decimal places, matching numeric(18,4) in the database.
 */
export type Rounding = 'half_up' | 'half_even' | 'down' | 'up';

export const SCALE = 4;
const ONE = 10n ** BigInt(SCALE);
const PATTERN = /^-?\d{1,14}(\.\d{1,4})?$/;

export class DecimalError extends Error {
  constructor(readonly code: 'INVALID_DECIMAL' | 'NOT_EXACT' | 'DIVIDE_BY_ZERO', message: string) {
    super(message);
  }
}

/** "12.5" -> 125000n (scaled by 10^4). */
export function parse(value: string): bigint {
  if (typeof value !== 'string' || !PATTERN.test(value)) throw new DecimalError('INVALID_DECIMAL', `"${value}" is not a valid decimal (up to 4 decimal places)`);
  const negative = value.startsWith('-');
  const [whole, frac = ''] = value.replace('-', '').split('.');
  const scaled = BigInt(whole) * ONE + BigInt(frac.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

/** 125000n -> "12.5000" */
export function format(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Integer division of n by d using the named rounding rule. Works for negative values too. */
export function roundDiv(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d === 0n) throw new DecimalError('DIVIDE_BY_ZERO', 'Division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  let q = abs / d;
  const r = abs % d;
  if (r !== 0n) {
    const twice = r * 2n;
    if (mode === 'up') q += 1n;
    else if (mode === 'half_up' && twice >= d) q += 1n;
    else if (mode === 'half_even' && (twice > d || (twice === d && q % 2n === 1n))) q += 1n;
    // 'down' truncates toward zero
  }
  return negative ? -q : q;
}

/** Rounds a scaled value to `dp` decimal places (0..4) and returns it still scaled by 10^4. */
export function roundTo(scaled: bigint, dp: number, mode: Rounding): bigint {
  if (dp < 0 || dp > SCALE) throw new RangeError('dp must be between 0 and 4');
  const unit = 10n ** BigInt(SCALE - dp);
  return roundDiv(scaled, unit, mode) * unit;
}

export const add = (a: string, b: string): string => format(parse(a) + parse(b));
export const sub = (a: string, b: string): string => format(parse(a) - parse(b));
export const cmp = (a: string, b: string): -1 | 0 | 1 => { const x = parse(a), y = parse(b); return x < y ? -1 : x > y ? 1 : 0; };

/** a * b, rounded to 4 decimal places with the given rule. */
export const mul = (a: string, b: string, mode: Rounding = 'half_up'): string => format(roundDiv(parse(a) * parse(b), ONE, mode));
export { ONE };

/** a / b, rounded to 4 decimal places with the given rule. */
export const divide = (a: string, b: string, mode: Rounding = 'half_up'): string => format(roundDiv(parse(a) * ONE, parse(b), mode));
