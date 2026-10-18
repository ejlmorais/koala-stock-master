import { withApi, readJson, ApiError } from '@/lib/api';
import { createProduct, listProducts } from '@/lib/v2/products';
import { AREAS, type Area } from '@/lib/v2/model';

/** GET /api/v2/products?area=bar&all=true — catálogo com stock e campos derivados. */
export const GET = withApi(async (req) => {
  const area = req.nextUrl.searchParams.get('area');
  if (area && !AREAS.includes(area as Area)) throw new ApiError(400, 'área tem de ser "bar" ou "kitchen"');
  return {
    products: await listProducts({
      all: req.nextUrl.searchParams.get('all') === 'true',
      area: (area as Area) ?? null,
    }),
  };
});

/** POST /api/v2/products — cria um produto (ver validateProduct para os campos). */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  return { product: await createProduct(body) };
});

export const OPTIONS = withApi(async () => ({}));
