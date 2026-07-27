import { sql } from '@/lib/db';
import { withApi } from '@/lib/api';

/**
 * GET /api/recipes/options — dropdown data for the transformation editor:
 * Zonesoft sale products (only those that actually sold) and active stock
 * products.
 */
export const GET = withApi(async () => {
  const saleProducts = await sql()`
    SELECT DISTINCT z.code, z.name, z.familia_name
    FROM zs_products z
    JOIN sale_items i ON i.zs_code = z.code
    ORDER BY z.name`;
  const stockProducts = await sql()`
    SELECT id, name, unit, area, category FROM products WHERE active ORDER BY area, name`;
  return { sale_products: saleProducts, stock_products: stockProducts };
});

export const OPTIONS = withApi(async () => ({}));
