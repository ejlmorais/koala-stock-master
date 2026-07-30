import { sql } from '@/lib/db';
import { withApi } from '@/lib/api';

/**
 * GET /api/recipes/options — data for the transformation editor:
 * every Zonesoft sale product that ever sold (with mapping status and recent
 * volume, so unmapped best-sellers surface first) and active stock products.
 */
export const GET = withApi(async () => {
  const saleProducts = await sql()`
    SELECT z.code, z.name, z.familia_name,
           EXISTS (SELECT 1 FROM sale_components sc WHERE sc.zs_code = z.code) AS has_recipe,
           EXISTS (SELECT 1 FROM products p
                   WHERE p.active
                     AND (lower(p.zonesoft_name) = lower(z.name)
                          OR p.zonesoft_name = z.code
                          OR lower(p.name) = lower(z.name))) AS has_link,
           COALESCE((SELECT SUM(i.qty) FROM sale_items i
                     WHERE i.zs_code = z.code
                       AND i.sale_date >= current_date - 90), 0) AS qty_90d
    FROM zs_products z
    WHERE EXISTS (SELECT 1 FROM sale_items i WHERE i.zs_code = z.code)
    ORDER BY z.name`;
  const stockProducts = await sql()`
    SELECT id, name, unit, area, category FROM products WHERE active ORDER BY area, name`;
  return { sale_products: saleProducts, stock_products: stockProducts };
});

export const OPTIONS = withApi(async () => ({}));
