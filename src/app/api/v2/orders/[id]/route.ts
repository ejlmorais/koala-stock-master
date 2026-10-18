import { withApi, readJson, ApiError } from '@/lib/api';
import { getOrder, updateOrder, type OrderStatus } from '@/lib/v2/orders';

function idOf(params: Record<string, string>): number {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'id inválido');
  return id;
}

export const GET = withApi(async (_req, params) => ({ order: await getOrder(idOf(params)) }));

/** PATCH { supplier?, status?, expected_on?, note?, lines? } — linhas só antes de haver receções. */
export const PATCH = withApi(async (req, params) => {
  const body = await readJson(req);
  return {
    order: await updateOrder(idOf(params), {
      supplier: body.supplier as string | undefined,
      status: body.status as OrderStatus | undefined,
      expected_on: body.expected_on as string | null | undefined,
      note: body.note as string | null | undefined,
      lines: body.lines as { product_id: number; packs?: number; units?: number }[] | undefined,
    }),
  };
});
export const OPTIONS = withApi(async () => ({}));
