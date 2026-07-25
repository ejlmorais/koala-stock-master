import { withApi, readJson, requireString, requireNumber, ApiError } from '@/lib/api';
import { listOrders, createOrder, type OrderItemInput } from '@/lib/orders';
import type { OrderStatus } from '@/lib/db';

const STATUSES: OrderStatus[] = ['draft', 'ordered', 'received', 'cancelled'];

export const GET = withApi(async (req) => {
  const status = req.nextUrl.searchParams.get('status');
  if (status && !STATUSES.includes(status as OrderStatus)) {
    throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  }
  return { orders: await listOrders((status as OrderStatus) ?? undefined) };
});

/**
 * POST /api/orders
 * { supplier, note?, status?: "draft"|"ordered",
 *   items: [{ product_id, qty, unit_cost?, area? }] }
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  const supplier = requireString(body.supplier, 'supplier');
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError(400, '"items" must be a non-empty array');
  }
  const items: OrderItemInput[] = (body.items as Record<string, unknown>[]).map((item, i) => ({
    product_id: requireNumber(item.product_id, `items[${i}].product_id`),
    qty: requireNumber(item.qty, `items[${i}].qty`),
    unit_cost: item.unit_cost != null ? requireNumber(item.unit_cost, `items[${i}].unit_cost`) : null,
    area: (item.area as OrderItemInput['area']) ?? null,
  }));
  return {
    order: await createOrder({
      supplier,
      note: (body.note as string) ?? null,
      status: body.status as OrderStatus | undefined,
      items,
    }),
  };
});

export const OPTIONS = withApi(async () => ({}));
