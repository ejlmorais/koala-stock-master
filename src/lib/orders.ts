import { sql, isArea, type Area, type Order, type OrderStatus } from './db';
import { ApiError } from './api';
import { applyMovement } from './stock';

export interface OrderItemInput {
  product_id: number;
  qty: number;
  unit_cost?: number | null;
  area?: Area | null;
}

export async function listOrders(status?: OrderStatus) {
  return sql()`
    SELECT o.*,
           COALESCE(SUM(i.qty * COALESCE(i.unit_cost, 0)), 0) AS total_cost,
           COUNT(i.id) AS item_count
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id
    WHERE (${status ?? null}::text IS NULL OR o.status = ${status ?? null})
    GROUP BY o.id
    ORDER BY o.created_at DESC`;
}

export async function getOrder(id: number) {
  const orders = await sql()`SELECT * FROM orders WHERE id = ${id}`;
  const order = orders[0] as unknown as Order | undefined;
  if (!order) throw new ApiError(404, `order ${id} not found`);
  const items = await sql()`
    SELECT i.*, p.name AS product_name, p.unit, p.area AS product_area,
           p.pack_size, i.qty * p.pack_size AS stock_qty
    FROM order_items i
    JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ${id}
    ORDER BY p.name`;
  return { ...order, items };
}

export async function createOrder(input: {
  supplier: string;
  note?: string | null;
  status?: OrderStatus;
  items: OrderItemInput[];
}) {
  const status: OrderStatus = input.status === 'ordered' ? 'ordered' : 'draft';
  const rows = await sql()`
    INSERT INTO orders (supplier, status, note, ordered_at)
    VALUES (${input.supplier}, ${status}, ${input.note ?? null},
            ${status === 'ordered' ? new Date().toISOString() : null})
    RETURNING id`;
  const orderId = rows[0].id as number;
  for (const item of input.items) {
    if (item.area != null && !isArea(item.area)) {
      throw new ApiError(400, `invalid area "${item.area}" (use "bar" or "kitchen")`);
    }
    await sql()`
      INSERT INTO order_items (order_id, product_id, qty, unit_cost, area)
      VALUES (${orderId}, ${item.product_id}, ${item.qty},
              ${item.unit_cost ?? null}, ${item.area ?? null})`;
  }
  return getOrder(orderId);
}

export async function updateOrder(
  id: number,
  patch: { supplier?: string; note?: string | null; status?: OrderStatus; items?: OrderItemInput[] }
) {
  const existing = await getOrder(id);
  if (existing.status === 'received' && (patch.status || patch.items)) {
    throw new ApiError(409, 'order already received — stock was applied; create a manual adjustment instead');
  }
  if (patch.status === 'received') {
    throw new ApiError(400, 'use POST /api/orders/{id}/receive to receive an order');
  }
  if (patch.supplier !== undefined || patch.note !== undefined || patch.status !== undefined) {
    await sql()`
      UPDATE orders SET
        supplier = COALESCE(${patch.supplier ?? null}, supplier),
        note = COALESCE(${patch.note ?? null}, note),
        status = COALESCE(${patch.status ?? null}, status),
        ordered_at = CASE WHEN ${patch.status ?? null} = 'ordered' THEN now() ELSE ordered_at END
      WHERE id = ${id}`;
  }
  if (patch.items) {
    await sql()`DELETE FROM order_items WHERE order_id = ${id}`;
    for (const item of patch.items) {
      await sql()`
        INSERT INTO order_items (order_id, product_id, qty, unit_cost, area)
        VALUES (${id}, ${item.product_id}, ${item.qty}, ${item.unit_cost ?? null}, ${item.area ?? null})`;
    }
  }
  return getOrder(id);
}

/**
 * Marks an order received and increases stock for every item. Order items are
 * counted in PACKS: receiving multiplies by the product's pack_size (1 grade
 * de Coca Cola → 24 garrafas; 1 pack de Abacate → 8 kg). `receivedBy` lands
 * in the movement ledger.
 */
export async function receiveOrder(id: number, receivedBy?: string | null) {
  const order = await getOrder(id);
  if (order.status === 'received') throw new ApiError(409, 'order already received');
  if (order.status === 'cancelled') throw new ApiError(409, 'order is cancelled');

  for (const item of order.items as Array<{
    product_id: number;
    qty: string;
    pack_size: string;
    area: Area | null;
    product_area: Area;
    product_name: string;
  }>) {
    const packs = Number(item.qty);
    const units = packs * Number(item.pack_size ?? 1);
    await applyMovement({
      productId: item.product_id,
      area: item.area ?? item.product_area,
      delta: units,
      reason: 'order',
      refType: 'order',
      refId: String(id),
      note: `Recebido de ${order.supplier} (${packs} × ${item.pack_size ?? 1})`,
      createdBy: receivedBy ?? null,
    });
  }
  await sql()`UPDATE orders SET status = 'received', received_at = now() WHERE id = ${id}`;
  return getOrder(id);
}
