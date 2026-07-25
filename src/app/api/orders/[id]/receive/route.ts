import { withApi, readJson } from '@/lib/api';
import { receiveOrder } from '@/lib/orders';

/**
 * POST /api/orders/{id}/receive — marks the order received and increases
 * stock for all items. Body (optional): { received_by }.
 */
export const POST = withApi(async (req, params) => {
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  return {
    order: await receiveOrder(Number(params.id), (body.received_by as string) ?? null),
  };
});

export const OPTIONS = withApi(async () => ({}));
