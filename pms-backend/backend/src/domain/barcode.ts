/**
 * Barcode helpers: EAN-13 check digits for in-store codes, and a Code 128 (set B) encoder that renders crisp SVG.
 * Pure functions with no framework code, so they are easy to test.
 */

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('EAN-13 needs exactly 12 digits before the check digit');
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}
export const isValidEan13 = (code: string): boolean => /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);

/** Code 128 bar/space widths for symbol values 0..106 (106 is the 7-element stop pattern). */
export const CODE128_PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104, STOP = 106;

/** Symbol values for a printable-ASCII string in code set B, including start, check and stop. */
export function code128B(data: string): number[] {
  if (data.length === 0) throw new Error('Nothing to encode');
  const values: number[] = [START_B];
  for (const ch of data) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Character "${ch}" cannot be encoded in Code 128 set B`);
    values.push(c - 32);
  }
  const checksum = values.reduce((acc, v, i) => acc + (i === 0 ? v : v * i), 0) % 103;
  return [...values, checksum, STOP];
}

/** Bars as [x, width] pairs in module units, plus the total width in modules. */
export function code128Bars(data: string): { bars: Array<[number, number]>; width: number } {
  const bars: Array<[number, number]> = [];
  let x = 0;
  for (const v of code128B(data)) {
    [...CODE128_PATTERNS[v]].forEach((w, idx) => {
      const width = Number(w);
      if (idx % 2 === 0) bars.push([x, width]); // even positions are bars, odd positions are spaces
      x += width;
    });
  }
  return { bars, width: x };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface LabelInput { title: string; subtitle?: string; barcode: string; footer?: string }

/** A self-contained SVG price/shelf label sized for 50 x 30 mm thermal stickers. All text is escaped. */
export function labelSvg(l: LabelInput): string {
  const { bars, width } = code128Bars(l.barcode);
  const quiet = 10, module = 1.6, barH = 34, total = (width + quiet * 2) * module;
  const W = Math.max(total, 190), offset = (W - width * module) / 2;
  const rects = bars.map(([x, w]) => `<rect x="${(offset + x * module).toFixed(2)}" y="38" width="${(w * module).toFixed(2)}" height="${barH}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="118" viewBox="0 0 ${W.toFixed(2)} 118" role="img" aria-label="${esc(l.title)} barcode ${esc(l.barcode)}">`
    + `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">`
    + `<text x="${(W / 2).toFixed(1)}" y="16" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700">${esc(clip(l.title, 30))}</text>`
    + (l.subtitle ? `<text x="${(W / 2).toFixed(1)}" y="31" text-anchor="middle" font-family="Arial, sans-serif" font-size="11">${esc(clip(l.subtitle, 36))}</text>` : '')
    + rects
    + `<text x="${(W / 2).toFixed(1)}" y="88" text-anchor="middle" font-family="monospace" font-size="12">${esc(l.barcode)}</text>`
    + (l.footer ? `<text x="${(W / 2).toFixed(1)}" y="108" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="700">${esc(l.footer)}</text>` : '')
    + `</g></svg>`;
}
