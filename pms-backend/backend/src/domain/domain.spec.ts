import { add, cmp, format, mul, parse, roundDiv, roundTo, sub } from './decimal';
import { computeTax, lineTotal, percentDiscount } from './pricing';
import { convertQuantity, fromBaseQuantity, toBaseQuantity } from './units';

describe('decimal', () => {
  it('parses and formats exactly', () => {
    expect(format(parse('12.5'))).toBe('12.5000');
    expect(format(parse('-0.0001'))).toBe('-0.0001');
    expect(format(parse('0'))).toBe('0.0000');
    expect(() => parse('1.23456')).toThrow();
    expect(() => parse('abc')).toThrow();
    expect(() => parse('1e3')).toThrow();
  });
  it('has no floating point error', () => {
    expect(add('0.1', '0.2')).toBe('0.3000');
    expect(sub('1', '0.9999')).toBe('0.0001');
    expect(mul('19.99', '3')).toBe('59.9700');
    expect(cmp('2', '10')).toBe(-1);
  });
  it('rounds by every named rule, for positive and negative values', () => {
    const r = (n: number, mode: any) => Number(roundDiv(BigInt(n), 10n, mode));
    expect([r(15, 'half_up'), r(25, 'half_up'), r(14, 'half_up')]).toEqual([2, 3, 1]);
    expect([r(15, 'half_even'), r(25, 'half_even'), r(35, 'half_even')]).toEqual([2, 2, 4]);
    expect([r(11, 'down'), r(19, 'down')]).toEqual([1, 1]);
    expect([r(11, 'up'), r(10, 'up')]).toEqual([2, 1]);
    expect([r(-15, 'half_up'), r(-25, 'half_even'), r(-11, 'down'), r(-11, 'up')]).toEqual([-2, -2, -1, -2]);
    expect(format(roundTo(parse('1.2349'), 2, 'half_up'))).toBe('1.2300');
    expect(format(roundTo(parse('1.2350'), 2, 'half_up'))).toBe('1.2400');
  });
});

describe('unit conversion', () => {
  it('converts pack sizes exactly', () => {
    expect(toBaseQuantity('3', '10')).toBe('30.0000'); // 3 strips of 10 tablets
    expect(toBaseQuantity('2', '1000')).toBe('2000.0000'); // 2 cartons
    expect(fromBaseQuantity('30', '10')).toBe('3.0000');
    expect(convertQuantity('1', '100', '10')).toBe('10.0000'); // 1 box = 10 strips
    expect(toBaseQuantity('0.5', '10')).toBe('5.0000'); // half a strip is 5 tablets
  });
  it('refuses conversions that would need rounding', () => {
    expect(fromBaseQuantity('25', '10')).toBe('2.5000'); // 2.5 strips is exact, so it is allowed
    expect(() => fromBaseQuantity('1', '3')).toThrow(/cannot be expressed exactly/); // a third of a pack
    expect(() => toBaseQuantity('0.00001', '3')).toThrow(); // more than 4 decimal places
    expect(() => convertQuantity('1', '10', '30')).toThrow(/cannot be expressed exactly/); // 1 strip is a third of a 30-pack
  });
});

describe('tax calculation', () => {
  const ex = (amount: string, rate: string, rounding: any = 'half_up') => computeTax({ amount, ratePercent: rate, inclusive: false, rounding });
  const inc = (amount: string, rate: string, rounding: any = 'half_up') => computeTax({ amount, ratePercent: rate, inclusive: true, rounding });

  it('adds tax on top for exclusive prices', () => {
    expect(ex('100', '15')).toEqual({ net: '100.0000', tax: '15.0000', gross: '115.0000' });
    expect(ex('19.99', '15')).toEqual({ net: '19.9900', tax: '3.0000', gross: '22.9900' }); // 2.9985 -> 3.00
    expect(ex('10', '0')).toEqual({ net: '10.0000', tax: '0.0000', gross: '10.0000' });
  });
  it('extracts tax from inclusive prices and always balances', () => {
    expect(inc('115', '15')).toEqual({ net: '100.0000', tax: '15.0000', gross: '115.0000' });
    for (const [amt, rate] of [['9.99', '15'], ['0.05', '15'], ['1234.56', '7.5'], ['0.01', '15'], ['99999.99', '15']]) {
      const t = inc(amt, rate);
      expect(add(t.net, t.tax)).toBe(t.gross);
      const e = ex(amt, rate);
      expect(add(e.net, e.tax)).toBe(e.gross);
    }
  });
  it('honours the configured rounding rule', () => {
    expect(ex('0.10', '15', 'half_up').tax).toBe('0.0200'); // 0.015 -> 0.02
    expect(ex('0.10', '15', 'half_even').tax).toBe('0.0200'); // 0.015 -> 0.02 (2 is even)
    expect(ex('0.30', '15', 'half_even').tax).toBe('0.0400'); // 0.045 -> 0.04 (4 is even)
    expect(ex('0.30', '15', 'half_up').tax).toBe('0.0500');
    expect(ex('0.30', '15', 'down').tax).toBe('0.0400');
    expect(ex('0.31', '15', 'up').tax).toBe('0.0500');
  });
  it('rejects impossible rates', () => {
    expect(() => ex('10', '101')).toThrow();
    expect(() => ex('10', '-1')).toThrow();
  });
  it('computes discounts and line totals to currency precision', () => {
    expect(percentDiscount('200', '10')).toBe('20.0000');
    expect(percentDiscount('19.99', '10')).toBe('2.0000'); // 1.999 -> 2.00
    expect(lineTotal('3.33', '3')).toBe('9.9900');
    expect(lineTotal('0.335', '3')).toBe('1.0100'); // 1.005 -> 1.01
  });
});

import { divide } from './decimal';
describe('division', () => {
  it('divides exactly and rounds only where it must', () => {
    expect(divide('25.5', '10')).toBe('2.5500');
    expect(divide('100', '3')).toBe('33.3333');
    expect(divide('200', '3')).toBe('66.6667');
    expect(divide('1', '8')).toBe('0.1250');
    expect(divide('100', '3', 'down')).toBe('33.3333');
    expect(() => divide('1', '0')).toThrow();
  });
});
