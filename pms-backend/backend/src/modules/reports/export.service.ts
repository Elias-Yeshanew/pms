import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Col, Row } from './report-types';
import { ReportResult } from './reports.service';

const MONEY = '#,##0.00;[Red]-#,##0.00';
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `"${(/^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
const shown = (c: Col, v: unknown): string => {
  if (v == null) return '';
  if (c.type === 'money') return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (c.type === 'qty') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (c.type === 'percent') return `${Number(v).toFixed(2)}%`;
  if (c.type === 'int') return Number(v).toLocaleString('en-US');
  return String(v);
};

/** Turns a finished report into a file. Numbers stay numbers in Excel so people can add them up; PDF is for printing. */
@Injectable()
export class ExportService {
  private subtitle(r: ReportResult, branchName: string | null): string {
    const parts = [r.period ? `${r.period.from} to ${r.period.to}` : 'As of today', branchName ?? 'All branches you can see'];
    return parts.join('  |  ');
  }

  csv(r: ReportResult): Buffer {
    const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
    for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(row[c.key])).join(','));
    if (r.totals) lines.push(r.columns.map((c, i) => csvCell(i === 0 ? 'Total' : r.totals![c.key] ?? '')).join(','));
    return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  }

  async xlsx(r: ReportResult, businessName: string, branchName: string | null): Promise<Buffer> {
    const wb = new ExcelJS.Workbook(); wb.creator = businessName; wb.created = new Date();
    const ws = wb.addWorksheet(r.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.addRow([businessName]).font = { bold: true, size: 14 };
    ws.addRow([r.title]).font = { bold: true, size: 12 };
    ws.addRow([this.subtitle(r, branchName)]).font = { color: { argb: 'FF666666' } };
    const head = ws.addRow(r.columns.map((c) => c.label));
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E5F' } }; cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
    const put = (row: Row) => r.columns.map((c) => { const v = row[c.key]; return v == null ? null : ['money', 'qty', 'percent', 'int'].includes(c.type) ? Number(v) : String(v); });
    for (const row of r.rows) ws.addRow(put(row));
    if (r.totals) { const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals![c.key] == null ? null : Number(r.totals![c.key])))); t.font = { bold: true }; t.border = { top: { style: 'thin' } }; }
    r.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.numFmt = c.type === 'money' ? MONEY : c.type === 'qty' ? '#,##0.##' : c.type === 'percent' ? '0.00"%"' : c.type === 'int' ? '#,##0' : '@';
      col.width = Math.max(12, Math.min(40, c.label.length + 4, ...[r.rows.reduce((m, row) => Math.max(m, String(row[c.key] ?? '').length), 0) + 2]));
      if (c.type !== 'text' && c.type !== 'date') col.alignment = { horizontal: 'right' };
    });
    ws.getRow(4).numFmt = '@';
    ws.addRow([]); ws.addRow([`Generated ${r.generatedAt}`]).font = { italic: true, color: { argb: 'FF888888' } };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  pdf(r: ReportResult, businessName: string, branchName: string | null): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const landscape = r.columns.length > 5;
      const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: r.title, Author: businessName } });
      const chunks: Buffer[] = [];
      doc.on('data', (d: Buffer) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right, bottom = doc.page.height - doc.page.margins.bottom - 18;
      const weights = r.columns.map((c) => (c.type === 'text' ? 2.4 : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      const xs: number[] = []; const ws: number[] = []; let x = left;
      for (const w of weights) { const cw = (w / total) * width; xs.push(x); ws.push(cw); x += cw; }
      const title = () => {
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text(businessName, left, doc.page.margins.top);
        doc.font('Helvetica-Bold').fontSize(11).text(r.title);
        doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(this.subtitle(r, branchName)).moveDown(0.6);
      };
      const header = () => {
        const y = doc.y; doc.rect(left, y, width, 18).fill('#1F4E5F'); doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
        r.columns.forEach((c, i) => doc.text(c.label, xs[i] + 3, y + 5, { width: ws[i] - 6, align: c.type === 'text' || c.type === 'date' ? 'left' : 'right', lineBreak: false, ellipsis: true }));
        doc.y = y + 20; doc.fillColor('#111');
      };
      const line = (cells: string[], bold = false, shade = false) => {
        if (doc.y + 16 > bottom) { doc.addPage(); header(); }
        const y = doc.y; if (shade) doc.rect(left, y - 2, width, 15).fill('#F1F5F6'); doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        r.columns.forEach((c, i) => doc.text(cells[i], xs[i] + 3, y, { width: ws[i] - 6, align: c.type === 'text' || c.type === 'date' ? 'left' : 'right', lineBreak: false, ellipsis: true }));
        doc.y = y + 15;
      };
      title(); header();
      if (!r.rows.length) doc.font('Helvetica-Oblique').fontSize(9).fillColor('#555').text('No data for this period.', left + 3);
      r.rows.forEach((row, n) => line(r.columns.map((c) => shown(c, row[c.key])), false, n % 2 === 1));
      if (r.totals) line(r.columns.map((c, i) => (i === 0 ? 'Total' : shown(c, r.totals![c.key]))), true);
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(pages.start + i); doc.font('Helvetica').fontSize(7.5).fillColor('#888');
        doc.text(`Generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, left, doc.page.height - 30, { width: width / 2, lineBreak: false });
        doc.text(`Page ${i + 1} of ${pages.count}`, left + width / 2, doc.page.height - 30, { width: width / 2, align: 'right', lineBreak: false });
      }
      doc.end();
    });
  }
}
