import { DecimalError, format, ONE, parse } from './decimal';

/**
 * Unit conversion. Stock is always stored in the product's base unit (e.g. tablets);
 * larger packs carry a factor (strip = 10, box = 100, carton = 1000).
 * Results must be exact: half a tablet is rejected instead of silently rounded, because a
 * rounded quantity would make the stock ledger disagree with what was physically sold.
 */
export function toBaseQuantity(quantity: string, factorToBase: string): string {
  const q = parse(quantity), f = parse(factorToBase);
  if (f <= 0n) throw new DecimalError('INVALID_DECIMAL', 'factor must be positive');
  const product = q * f;
  if (product % ONE !== 0n) throw new DecimalError('NOT_EXACT', `${quantity} x ${factorToBase} cannot be expressed in 4 decimal places`);
  return format(product / ONE);
}

export function fromBaseQuantity(baseQuantity: string, factorToBase: string): string {
  const b = parse(baseQuantity), f = parse(factorToBase);
  if (f <= 0n) throw new DecimalError('INVALID_DECIMAL', 'factor must be positive');
  const scaled = b * ONE;
  if (scaled % f !== 0n) throw new DecimalError('NOT_EXACT', `${baseQuantity} base units cannot be expressed exactly (4 decimal places) in a pack of ${factorToBase}`);
  return format(scaled / f);
}

/** Converts between two pack sizes of the same product, exactly. */
export function convertQuantity(quantity: string, fromFactor: string, toFactor: string): string {
  return fromBaseQuantity(toBaseQuantity(quantity, fromFactor), toFactor);
}
