import { Queryable } from '../../database/database.service';

/** Tables that will hold product transactions. Only those that already exist are checked, so this works at every milestone. */
const TRANSACTION_TABLES = ['inventory.stock_batches', 'inventory.stock_movements', 'sales.sale_items', 'procurement.purchase_order_items', 'procurement.purchase_request_items'];

/** A product that has already been bought, stocked or sold must keep its pack structure, or old quantities would change meaning. */
export async function isProductInUse(q: Queryable, productId: string): Promise<boolean> {
  for (const table of TRANSACTION_TABLES) {
    const exists = await q.query(`select to_regclass($1) as t`, [table]);
    if (!exists.rows[0].t) continue;
    const used = await q.query(`select 1 from ${table} where product_id = $1 limit 1`, [productId]); // table names are constants above
    if (used.rowCount) return true;
  }
  return false;
}
