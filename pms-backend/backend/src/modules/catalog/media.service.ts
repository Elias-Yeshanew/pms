import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { ENV, Env } from '../../config/env';
import { DatabaseService, maybeOne } from '../../database/database.service';
import { ean13CheckDigit, labelSvg } from '../../domain/barcode';
import { format, parse, roundTo } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { ProductsService } from './products.service';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Decides the real image type from the file's first bytes, never from its name or the type the client claims. */
export function sniffImage(buf: Buffer): { ext: 'png' | 'jpg' | 'webp'; mime: string } | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

@Injectable()
export class MediaService {
  private readonly root: string;
  constructor(
    private readonly db: DatabaseService, private readonly products: ProductsService, private readonly sequences: SequenceService,
    private readonly settings: SettingsService, private readonly audit: AuditService, @Inject(ENV) env: Env,
  ) { this.root = resolve(env.UPLOAD_DIR, 'products'); }

  // ---- internal barcodes ----
  /** Creates an in-store EAN-13 (starts with 2, the range reserved for private use) for a pack of the product. */
  async generateBarcode(auth: AuthContext, productId: string, unitId: string) {
    await this.products.get(productId);
    await this.db.tx(async (q: PoolClient) => {
      if (!(await maybeOne(q, `select 1 from catalog.product_units where product_id = $1 and unit_id = $2`, [productId, unitId]))) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have this unit.');
      const n = await this.sequences.next(q, 'barcode');
      const first12 = `2${n.padStart(11, '0').slice(-11)}`;
      const code = first12 + ean13CheckDigit(first12);
      const first = !(await maybeOne(q, `select 1 from catalog.product_barcodes where product_id = $1`, [productId]));
      await q.query(`insert into catalog.product_barcodes (product_id, unit_id, barcode, is_primary, created_by) values ($1, $2, $3, $4, $5)`, [productId, unitId, code, first, auth.userId]);
      await this.audit.record({ action: 'product.barcode_generated', entityType: 'product', entityId: productId, newValue: { barcode: code, unitId } }, q);
    });
    return this.products.get(productId);
  }

  // ---- labels ----
  private async labelData(productId: string, barcodeId: string) {
    const row = await maybeOne<{ name: string; strength: string | null; barcode: string; unit_code: string; price: string | null }>(this.db,
      `select p.name, p.strength, b.barcode, u.code as unit_code,
              (select pr.amount from catalog.product_prices pr where pr.product_id = p.id and pr.unit_id = b.unit_id and pr.price_type = 'selling' and pr.effective_to is null) as price
         from catalog.product_barcodes b join catalog.products p on p.id = b.product_id join catalog.units u on u.id = b.unit_id where b.id = $1 and b.product_id = $2`, [barcodeId, productId]);
    if (!row) throw AppError.notFound('BARCODE_NOT_FOUND', 'Barcode not found.');
    const dp = await this.settings.get('business.currency_decimals');
    const currency = await this.settings.get('business.currency');
    const money = (amount: string) => { const [whole, frac = ''] = format(roundTo(parse(amount), dp, 'half_up')).split('.'); return dp > 0 ? `${whole}.${frac.slice(0, dp)}` : whole; };
    const footer = row.price === null ? undefined : `${currency} ${money(row.price)}`;
    return { title: row.name, subtitle: [row.strength, `per ${row.unit_code}`].filter(Boolean).join(' · '), barcode: row.barcode, footer };
  }

  async labelSvg(productId: string, barcodeId: string): Promise<string> { return labelSvg(await this.labelData(productId, barcodeId)); }

  /** A printable page of labels. Every value is escaped; the page carries no scripts. */
  async labelSheet(items: Array<{ productId: string; barcodeId: string; copies: number }>, columns: number): Promise<string> {
    const cells: string[] = [];
    for (const it of items) {
      const svg = await this.labelSvg(it.productId, it.barcodeId);
      for (let i = 0; i < it.copies; i++) cells.push(`<div class="cell">${svg}</div>`);
    }
    if (cells.length > 500) throw AppError.badRequest('TOO_MANY_LABELS', 'A sheet can hold at most 500 labels.');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc('Barcode labels')}</title>`
      + `<style>@page{margin:8mm}body{margin:0;font-family:Arial,sans-serif}.grid{display:grid;grid-template-columns:repeat(${columns},1fr);gap:4mm}.cell{break-inside:avoid;border:1px dashed #bbb;padding:2mm;text-align:center}.cell svg{max-width:100%;height:auto}</style></head><body><div class="grid">${cells.join('')}</div></body></html>`;
  }

  // ---- images ----
  async saveImage(auth: AuthContext, productId: string, data: Buffer) {
    await this.products.get(productId);
    if (data.length === 0) throw AppError.badRequest('EMPTY_FILE', 'The file is empty.');
    if (data.length > MAX_IMAGE_BYTES) throw AppError.badRequest('FILE_TOO_LARGE', 'Images can be at most 2 MB.');
    const kind = sniffImage(data);
    if (!kind) throw AppError.badRequest('UNSUPPORTED_IMAGE', 'Only PNG, JPEG and WebP images are accepted.');
    await mkdir(this.root, { recursive: true });
    const name = `${productId}-${randomBytes(8).toString('hex')}.${kind.ext}`; // generated name: nothing from the upload is used in the path
    await writeFile(join(this.root, name), data, { flag: 'wx', mode: 0o640 });
    const old = await maybeOne<{ image_path: string | null }>(this.db, `select image_path from catalog.products where id = $1`, [productId]);
    await this.db.tx(async (q) => {
      await q.query(`update catalog.products set image_path = $2, version = version + 1, updated_by = $3 where id = $1`, [productId, name, auth.userId]);
      await this.audit.record({ action: 'product.image_changed', entityType: 'product', entityId: productId, newValue: { bytes: data.length, type: kind.mime } }, q);
    });
    if (old?.image_path) await this.remove(old.image_path);
    return { productId, size: data.length, type: kind.mime };
  }

  private async remove(name: string) { await unlink(this.safePath(name)).catch(() => undefined); }
  private safePath(name: string): string {
    const full = resolve(this.root, name);
    if (!full.startsWith(this.root + sep)) throw AppError.notFound('IMAGE_NOT_FOUND', 'Image not found.');
    return full;
  }

  async readImage(productId: string): Promise<{ data: Buffer; mime: string }> {
    const row = await maybeOne<{ image_path: string | null }>(this.db, `select image_path from catalog.products where id = $1`, [productId]);
    if (!row?.image_path) throw AppError.notFound('IMAGE_NOT_FOUND', 'This product has no image.');
    try {
      return { data: await readFile(this.safePath(row.image_path)), mime: MIME[row.image_path.split('.').pop()!] ?? 'application/octet-stream' };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw AppError.notFound('IMAGE_NOT_FOUND', 'This product has no image.');
    }
  }

  async deleteImage(auth: AuthContext, productId: string) {
    const row = await maybeOne<{ image_path: string | null }>(this.db, `select image_path from catalog.products where id = $1`, [productId]);
    if (!row) throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found.');
    if (!row.image_path) return;
    await this.db.tx(async (q) => {
      await q.query(`update catalog.products set image_path = null, version = version + 1, updated_by = $2 where id = $1`, [productId, auth.userId]);
      await this.audit.record({ action: 'product.image_removed', entityType: 'product', entityId: productId }, q);
    });
    await this.remove(row.image_path);
  }
}
