import { add, format, parse, ONE, Rounding, roundDiv, roundTo, sub } from './decimal';

export interface TaxInput {
  /** Line amount. If inclusive, this already contains the tax. */
  amount: string;
  /** Percentage, e.g. "15" or "7.5". */
  ratePercent: string;
  inclusive: boolean;
  rounding: Rounding;
  /** Decimal places of the currency (ETB uses 2). */
  currencyDecimals?: number;
}

export interface TaxResult { net: string; tax: string; gross: string }

/**
 * Splits an amount into net, tax and gross. Tax is rounded once, per line, by the configured rule;
 * net or gross is then derived so that net + tax = gross always holds exactly.
 */
export function computeTax(input: TaxInput): TaxResult {
  const dp = input.currencyDecimals ?? 2;
  const amount = parse(input.amount);
  const rate = parse(input.ratePercent);
  const hundred = 100n * ONE;
  if (rate < 0n || rate > hundred) throw new RangeError('rate must be between 0 and 100');

  if (input.inclusive) {
    const gross = roundTo(amount, dp, input.rounding);
    const net = roundTo(roundDiv(gross * hundred, hundred + rate, input.rounding), dp, input.rounding);
    return { net: format(net), tax: format(gross - net), gross: format(gross) };
  }
  const net = roundTo(amount, dp, input.rounding);
  const tax = roundTo(roundDiv(net * rate, hundred, input.rounding), dp, input.rounding);
  return { net: format(net), tax: format(tax), gross: format(net + tax) };
}

/** Percentage discount on an amount, rounded to currency decimals. Returns the discount amount. */
export function percentDiscount(amount: string, percent: string, rounding: Rounding = 'half_up', currencyDecimals = 2): string {
  return format(roundTo(roundDiv(parse(amount) * parse(percent), 100n * ONE, rounding), currencyDecimals, rounding));
}

export const lineTotal = (unitPrice: string, quantity: string, rounding: Rounding = 'half_up', dp = 2): string =>
  format(roundTo(roundDiv(parse(unitPrice) * parse(quantity), ONE, rounding), dp, rounding));

export { add, sub };
