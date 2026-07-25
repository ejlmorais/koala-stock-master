import { sql, isArea } from '@/lib/db';
import { withApi, readJson, ApiError } from '@/lib/api';

async function getProduct(id: number) {
  const rows = await sql()`
    SELECT p.*, COALESCE(SUM(l.qty), 0) AS total_qty
    FROM products p
    LEFT JOIN stock_levels l ON l.product_id = p.id
    WHERE p.id = ${id}
    GROUP BY p.id`;
  if (!rows[0]) throw new ApiError(404, `product ${id} not found`);
  return rows[0];
}

export const GET = withApi(async (_req, params) => {
  return { product: await getProduct(Number(params.id)) };
});

export const PATCH = withApi(async (req, params) => {
  const id = Number(params.id);
  await getProduct(id);
  const body = await readJson(req);
  if (body.area !== undefined && !isArea(body.area)) {
    throw new ApiError(400, 'area must be "bar" or "kitchen"');
  }
  await sql()`
    UPDATE products SET
      name = COALESCE(${(body.name as string) ?? null}, name),
      unit = COALESCE(${(body.unit as string) ?? null}, unit),
      area = COALESCE(${(body.area as string) ?? null}, area),
      zonesoft_name = CASE WHEN ${body.zonesoft_name !== undefined}
                           THEN ${(body.zonesoft_name as string) ?? null} ELSE zonesoft_name END,
      units_per_sale = COALESCE(${(body.units_per_sale as number) ?? null}, units_per_sale),
      min_level = CASE WHEN ${body.min_level !== undefined}
                       THEN ${(body.min_level as number) ?? null} ELSE min_level END,
      active = COALESCE(${(body.active as boolean) ?? null}, active)
    WHERE id = ${id}`;
  return { product: await getProduct(id) };
});

export const DELETE = withApi(async (_req, params) => {
  const id = Number(params.id);
  await getProduct(id);
  // Soft delete: keeps movement and sales history intact.
  await sql()`UPDATE products SET active = false WHERE id = ${id}`;
  return { ok: true };
});

export const OPTIONS = withApi(async () => ({}));
