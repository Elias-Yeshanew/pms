import { columnsFor, renderReceipt, ReceiptData } from './receipt';

const base: ReceiptData = {
  businessName: 'Hayat Pharmacy', branchName: 'Main Dispenser', branchAddress: 'Bole Road', branchPhone: '0111', reference: 'S-000042', soldAt: '2026-11-02 10:15', cashier: 'abel', currency: 'ETB',
  lines: [{ name: 'Paracetamol 500 mg', unit: 'strip', quantity: '2.0000', unitPrice: '25.5000', discount: '0.0000', total: '51.0000' }, { name: 'Amoxicillin 250 mg capsules extra long name here', unit: 'capsule', quantity: '10.0000', unitPrice: '3.0000', discount: '3.0000', total: '27.0000' }],
  subtotal: '67.8261', discountTotal: '3.0000', taxTotal: '10.1739', total: '78.0000', payments: [{ method: 'Cash', amount: '80.0000' }], changeGiven: '2.0000', creditTotal: '0.0000', footer: 'Thank you',
};

describe('receipt', () => {
  it('picks the line width from the paper', () => { expect(columnsFor(58)).toBe(32); expect(columnsFor(80)).toBe(48); });
  it('never exceeds the paper width, on either size', () => {
    for (const w of [32, 48]) renderReceipt(base, w).split('\n').forEach((l) => expect(l.length).toBeLessThanOrEqual(w));
  });
  it('shows the details a customer needs, with tidy money and quantities', () => {
    const t = renderReceipt(base, 48);
    expect(t).toContain('Hayat Pharmacy');
    expect(t).toContain('S-000042');
    expect(t).toMatch(/2 strip x 25\.50\s+51\.00/);
    expect(t).toMatch(/10 capsule x 3\.00\s+27\.00/);
    expect(t).toMatch(/discount\s+-3\.00/);
    expect(t).toMatch(/TOTAL ETB\s+78\.00/);
    expect(t).toMatch(/Change\s+2\.00/);
    expect(t).not.toContain('REPRINT');
  });
  it('marks reprints and cancelled receipts, and handles account sales', () => {
    const t = renderReceipt({ ...base, reprint: true, cancelled: true, creditTotal: '30.0000', payments: [] }, 32);
    expect(t).toContain('*** REPRINT ***');
    expect(t).toContain('*** CANCELLED ***');
    expect(t).toMatch(/On account\s+30\.00/);
  });
});
