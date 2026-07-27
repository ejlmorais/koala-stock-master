import { sql } from '@/lib/db';
import { withApi, readJson, requireString, ApiError } from '@/lib/api';

/**
 * GET /api/recipes — all transformations: sale product (zs_code) → stock
 * components. Grouped per zs_code with names resolved.
 */
export const GET = withApi(async () => {
  const rows = await sql()`
    SELECT sc.zs_code, z.name AS sale_name, z.familia_name,
           sc.product_id, p.name AS product_name, p.unit, sc.qty_per_sale
    FROM sale_components sc
    LEFT JOIN zs_products z ON z.code = sc.zs_code
    JOIN products p ON p.id = sc.product_id
    ORDER BY z.name, p.name`;
  const grouped = new Map<string, { zs_code: string; sale_name: string | null; familia_name: string | null; components: unknown[] }>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const code = r.zs_code as string;
    let entry = grouped.get(code);
    if (!entry) {
      entry = {
        zs_code: code,
        sale_name: (r.sale_name as string) ?? null,
        familia_name: (r.familia_name as string) ?? null,
        components: [],
      };
      grouped.set(code, entry);
    }
    entry.components.push({
      product_id: r.product_id,
      product_name: r.product_name,
      unit: r.unit,
      qty_per_sale: r.qty_per_sale,
    });
  }
  return { recipes: [...grouped.values()] };
});

/**
 * PUT /api/recipes — replaces one sale product's components.
 * { zs_code, components: [{ product_id, qty_per_sale }] }
 * An empty components array removes the transformation.
 */
export const PUT = withApi(async (req) => {
  const body = await readJson(req);
  const zsCode = requireString(body.zs_code, 'zs_code');
  if (!Array.isArray(body.components)) {
    throw new ApiError(400, '"components" must be an array');
  }
  await sql()`DELETE FROM sale_components WHERE zs_code = ${zsCode}`;
  for (const c of body.components as Record<string, unknown>[]) {
    const productId = Number(c.product_id);
    const qty = Number(c.qty_per_sale);
    if (!Number.isInteger(productId) || !Number.isFinite(qty) || qty <= 0) {
      throw new ApiError(400, 'each component needs product_id and qty_per_sale > 0');
    }
    await sql()`
      INSERT INTO sale_components (zs_code, product_id, qty_per_sale)
      VALUES (${zsCode}, ${productId}, ${qty})
      ON CONFLICT (zs_code, product_id) DO UPDATE SET qty_per_sale = ${qty}`;
  }
  return { zs_code: zsCode, components: body.components.length };
});

export const OPTIONS = withApi(async () => ({}));
