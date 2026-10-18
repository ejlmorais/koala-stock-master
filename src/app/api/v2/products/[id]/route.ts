import { withApi, readJson, ApiError } from '@/lib/api';
import { deactivateProduct, getProduct, updateProduct } from '@/lib/v2/products';

function idOf(params: Record<string, string>): number {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'id inválido');
  return id;
}

export const GET = withApi(async (_req, params) => ({ product: await getProduct(idOf(params)) }));

/** PATCH /api/v2/products/{id} — campos parciais; o conjunto é validado. */
export const PATCH = withApi(async (req, params) => {
  const body = await readJson(req);
  return { product: await updateProduct(idOf(params), body) };
});

/** DELETE — desativa (o histórico fica). */
export const DELETE = withApi(async (_req, params) => deactivateProduct(idOf(params)));

export const OPTIONS = withApi(async () => ({}));
