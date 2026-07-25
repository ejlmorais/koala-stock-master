import { sql, isArea } from '@/lib/db';
import { withApi, readJson, requireNumber, ApiError } from '@/lib/api';
import { applyMovement } from '@/lib/stock';

/**
 * Manual stock update. Two modes:
 *  - { product_id, delta }: relative change (e.g. -2 broken bottles)
 *  - { product_id, qty }:   absolute count (e.g. after a physical inventory)
 * Optional: area (defaults to the product's), note, created_by.
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  const productId = requireNumber(body.product_id, 'product_id');

  const products = await sql()`SELECT id, area FROM products WHERE id = ${productId} AND active`;
  const product = products[0] as { id: number; area: 'bar' | 'kitchen' } | undefined;
  if (!product) throw new ApiError(404, `product ${productId} not found`);

  const area = (body.area as string) ?? product.area;
  if (!isArea(area)) throw new ApiError(400, 'area must be "bar" or "kitchen"');

  let delta: number;
  let reason: 'manual' | 'adjustment';
  if (body.delta !== undefined) {
    delta = requireNumber(body.delta, 'delta');
    reason = 'manual';
  } else if (body.qty !== undefined) {
    const target = requireNumber(body.qty, 'qty');
    const rows = await sql()`
      SELECT qty FROM stock_levels WHERE product_id = ${productId} AND area = ${area}`;
    const current = rows[0] ? Number(rows[0].qty) : 0;
    delta = target - current;
    reason = 'adjustment';
  } else {
    throw new ApiError(400, 'provide "delta" (relative) or "qty" (absolute count)');
  }

  if (delta !== 0) {
    await applyMovement({
      productId,
      area,
      delta,
      reason,
      note: (body.note as string) ?? null,
      createdBy: (body.created_by as string) ?? null,
    });
  }

  const rows = await sql()`
    SELECT qty FROM stock_levels WHERE product_id = ${productId} AND area = ${area}`;
  return { product_id: productId, area, delta, qty: rows[0] ? Number(rows[0].qty) : 0 };
});

export const OPTIONS = withApi(async () => ({}));
