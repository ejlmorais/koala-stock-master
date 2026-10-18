import { withApi, readJson, ApiError } from '@/lib/api';
import { reverseReception } from '@/lib/v2/orders';

/** POST { by? } — reverte uma receção (movimentos simétricos) e reabre a encomenda. */
export const POST = withApi(async (req, params) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new ApiError(400, 'id inválido');
  const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  return { order: await reverseReception(id, (body.by as string) ?? null) };
});
export const OPTIONS = withApi(async () => ({}));
