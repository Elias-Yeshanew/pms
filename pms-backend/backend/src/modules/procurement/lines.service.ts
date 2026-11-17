import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { Queryable, maybeOne } from '../../database/database.service';
import { cmp, format, parse } from '../../domain/decimal';
import { toBaseQuantity } from '../../domain/units';
import { handleDecimal } from '../inventory/inventory.service';

export interface ResolvedLine { productId: string; unitId: string; quantity: string; baseQuantity: string; factor: string; taxCategoryId: string | null }

/** Turns "product, pack, quantity" lines into exact base quantities, checking the product, pack and duplicates. */
@Injectable()
export class LinesService {
  async resolve(q: Queryable, items: Array<{ productId: string; unitId?: string; quantity: string }>): Promise<ResolvedLine[]> {
    const out: ResolvedLine[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const p = await maybeOne<{ is_active: boolean; base_unit_id: string; tax_category_id: string | null }>(q, `select is_active, base_unit_id, tax_category_id from catalog.products where id = $1`, [it.productId]);
      if (!p) throw AppError.badRequest('PRODUCT_NOT_FOUND', 'A product does not exist.');
      if (!p.is_active) throw AppError.badRequest('PRODUCT_INACTIVE', 'A product is inactive and cannot be ordered.');
      const unitId = it.unitId ?? p.base_unit_id;
      const pu = await maybeOne<{ factor_to_base: string; is_purchasable: boolean }>(q, `select factor_to_base, is_purchasable from catalog.product_units where product_id = $1 and unit_id = $2`, [it.productId, unitId]);
      if (!pu) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have this unit.');
      if (!pu.is_purchasable) throw AppError.badRequest('UNIT_NOT_PURCHASABLE', 'This pack size cannot be purchased.');
      const key = `${it.productId}|${unitId}`;
      if (seen.has(key)) throw AppError.badRequest('DUPLICATE_LINE', 'The same product and pack size appears twice. Combine the quantities.');
      seen.add(key);
      const quantity = handleDecimal(() => format(parse(it.quantity)));
      if (cmp(quantity, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
      out.push({ productId: it.productId, unitId, quantity, baseQuantity: handleDecimal(() => toBaseQuantity(quantity, pu.factor_to_base)), factor: pu.factor_to_base, taxCategoryId: p.tax_category_id });
    }
    return out;
  }
}
