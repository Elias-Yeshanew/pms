/** Plain-text receipt for thermal printers. 58 mm paper holds 32 characters per line, 80 mm holds 48. */
export interface ReceiptData {
  businessName: string; branchName: string; branchAddress?: string | null; branchPhone?: string | null;
  reference: string; soldAt: string; cashier: string; customer?: string | null; currency: string; footer?: string; reprint?: boolean; cancelled?: boolean;
  lines: Array<{ name: string; unit: string; quantity: string; unitPrice: string; discount: string; total: string }>;
  subtotal: string; discountTotal: string; taxTotal: string; total: string;
  payments: Array<{ method: string; amount: string; reference?: string | null }>; changeGiven: string; creditTotal: string;
}

export const columnsFor = (paperWidth: number): number => (paperWidth <= 58 ? 32 : 48);

const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
const center = (s: string, w: number) => (s.length >= w ? fit(s, w) : ' '.repeat(Math.floor((w - s.length) / 2)) + s);
const pair = (left: string, right: string, w: number) => { const gap = w - right.length; return fit(left, Math.max(1, gap - 1)).padEnd(Math.max(1, gap)) + right; };
/** Drops trailing zeros beyond two decimals so 25.5000 prints as 25.50 and 2.0000 as 2. */
const money = (v: string) => { const [w, f = ''] = v.split('.'); const frac = f.replace(/0+$/, '').padEnd(2, '0'); return `${w}.${frac}`; };
const qty = (v: string) => { const [w, f = ''] = v.split('.'); const frac = f.replace(/0+$/, ''); return frac ? `${w}.${frac}` : w; };

export function renderReceipt(d: ReceiptData, width: number): string {
  const rule = '-'.repeat(width), out: string[] = [];
  if (d.businessName) out.push(center(d.businessName, width));
  out.push(center(d.branchName, width));
  if (d.branchAddress) out.push(center(d.branchAddress, width));
  if (d.branchPhone) out.push(center(`Tel ${d.branchPhone}`, width));
  out.push(rule, pair('Receipt', d.reference, width), pair('Date', d.soldAt, width), pair('Cashier', d.cashier, width));
  if (d.customer) out.push(pair('Customer', d.customer, width));
  if (d.cancelled) out.push(center('*** CANCELLED ***', width));
  if (d.reprint) out.push(center('*** REPRINT ***', width));
  out.push(rule);
  for (const l of d.lines) {
    out.push(fit(l.name, width));
    out.push(pair(`  ${qty(l.quantity)} ${l.unit} x ${money(l.unitPrice)}`, money(l.total), width));
    if (Number(l.discount) > 0) out.push(pair('  discount', `-${money(l.discount)}`, width));
  }
  out.push(rule, pair('Subtotal', money(d.subtotal), width));
  if (Number(d.discountTotal) > 0) out.push(pair('Discounts', `-${money(d.discountTotal)}`, width));
  out.push(pair('Tax', money(d.taxTotal), width), pair(`TOTAL ${d.currency}`, money(d.total), width), rule);
  for (const p of d.payments) out.push(pair(p.method + (p.reference ? ` (${p.reference})` : ''), money(p.amount), width));
  if (Number(d.creditTotal) > 0) out.push(pair('On account', money(d.creditTotal), width));
  if (Number(d.changeGiven) > 0) out.push(pair('Change', money(d.changeGiven), width));
  if (d.footer) out.push(rule, ...d.footer.split('\n').map((l) => center(l, width)));
  return out.join('\n');
}
