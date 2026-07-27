import { withApi } from '@/lib/api';
import { countHistory } from '@/lib/stock';

/** GET /api/stock/counts?product_id=&limit= — full counting history. */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const productId = q.get('product_id') ? Number(q.get('product_id')) : undefined;
  const limit = Math.min(Number(q.get('limit') ?? 100), 500);
  return { counts: await countHistory({ productId, limit }) };
});

export const OPTIONS = withApi(async () => ({}));
