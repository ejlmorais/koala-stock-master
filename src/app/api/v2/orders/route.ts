import { withApi, readJson, ApiError } from '@/lib/api';
import { createOrder, listOrders, type OrderStatus } from '@/lib/v2/orders';

/** GET /api/v2/orders?status=rascunho|enviada|recebida|cancelada */
export const GET = withApi(async (req) => ({
  orders: await listOrders(req.nextUrl.searchParams.get('status') as OrderStatus | null),
}));

/** POST /api/v2/orders { supplier, status?, expected_on?, note?, created_by?, lines: [{ product_id, packs? | units? }] } */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  if (typeof body.supplier !== 'string') throw new ApiError(400, '"supplier" é obrigatório');
  return {
    order: await createOrder({
      supplier: body.supplier,
      status: body.status as OrderStatus | undefined,
      expected_on: (body.expected_on as string) ?? null,
      note: (body.note as string) ?? null,
      created_by: (body.created_by as string) ?? null,
      external_ref: (body.external_ref as string) ?? null,
      lines: (body.lines as { product_id: number; packs?: number; units?: number }[]) ?? [],
    }),
  };
});
export const OPTIONS = withApi(async () => ({}));
