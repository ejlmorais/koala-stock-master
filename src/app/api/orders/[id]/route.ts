import { sql, type OrderStatus } from '@/lib/db';
import { withApi, readJson, ApiError } from '@/lib/api';
import { getOrder, updateOrder, type OrderItemInput } from '@/lib/orders';

export const GET = withApi(async (_req, params) => {
  return { order: await getOrder(Number(params.id)) };
});

export const PATCH = withApi(async (req, params) => {
  const id = Number(params.id);
  const body = await readJson(req);
  if (body.status !== undefined && !['draft', 'ordered', 'cancelled'].includes(body.status as string)) {
    throw new ApiError(400, 'status must be "draft", "ordered" or "cancelled" (receive via /receive)');
  }
  return {
    order: await updateOrder(id, {
      supplier: body.supplier as string | undefined,
      note: body.note as string | null | undefined,
      status: body.status as OrderStatus | undefined,
      items: body.items as OrderItemInput[] | undefined,
    }),
  };
});

export const DELETE = withApi(async (_req, params) => {
  const id = Number(params.id);
  const order = await getOrder(id);
  if (order.status === 'received') {
    throw new ApiError(409, 'order already received — stock was applied; cancel is not possible');
  }
  await sql()`DELETE FROM orders WHERE id = ${id}`;
  return { ok: true };
});

export const OPTIONS = withApi(async () => ({}));
