import { CODE128_PATTERNS, code128B, code128Bars, ean13CheckDigit, isValidEan13, labelSvg } from './barcode';
import { parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('reads plain, quoted and multi-line fields, BOM and Windows line endings', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('\uFEFFname,note\r\n"Smith, J","said ""hi"""\r\n"two\nlines",x\r\n')).toEqual([['name', 'note'], ['Smith, J', 'said "hi"'], ['two\nlines', 'x']]);
    expect(parseCsv('a,,c\n,,\n')).toEqual([['a', '', 'c'], ['', '', '']]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
  it('rejects an unclosed quote and round-trips through toCsv', () => {
    expect(() => parseCsv('a,"b\nc')).toThrow(/unclosed quote/);
    const rows = [['x', 'a,b', 'say "no"', 'line\nbreak', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('barcodes', () => {
  it('computes EAN-13 check digits correctly', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13CheckDigit('590123412345')).toBe(7);
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidEan13('123')).toBe(false);
    expect(() => ean13CheckDigit('12345')).toThrow();
  });
  it('has a structurally valid Code 128 pattern table', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.slice(0, 106).forEach((p) => { expect(p).toHaveLength(6); expect([...p].reduce((a, c) => a + Number(c), 0)).toBe(11); });
    expect(CODE128_PATTERNS[106]).toHaveLength(7);
    expect([...CODE128_PATTERNS[106]].reduce((a, c) => a + Number(c), 0)).toBe(13);
    expect(new Set(CODE128_PATTERNS).size).toBe(107); // no two symbols share a pattern
  });
  it('encodes with the correct start, check and stop symbols', () => {
    const v = code128B('PJJ123C');
    expect(v[0]).toBe(104);
    expect(v.slice(1, 8)).toEqual(['P', 'J', 'J', '1', '2', '3', 'C'].map((c) => c.charCodeAt(0) - 32));
    const expected = (104 + v.slice(1, 8).reduce((a, x, i) => a + x * (i + 1), 0)) % 103;
    expect(v[8]).toBe(expected);
    expect(v[9]).toBe(106);
    expect(() => code128B('')).toThrow();
    expect(() => code128B('é')).toThrow();
  });
  it('lays out bars within the symbol width', () => {
    const { bars, width } = code128Bars('6001234500011');
    expect(width).toBe(11 * (1 + 13 + 1) + 13); // start + 13 data + check = 15 symbols of 11 modules, plus the 13-module stop
    expect(bars.every(([x, w]) => x >= 0 && x + w <= width)).toBe(true);
  });
  it('renders a label and escapes anything that could break the markup', () => {
    const svg = labelSvg({ title: 'Para <b>"x"</b> & co', subtitle: "500 mg's", barcode: '6001234500011', footer: 'ETB 25.50' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('&amp; co');
    expect(svg).toContain('ETB 25.50');
  });
});
