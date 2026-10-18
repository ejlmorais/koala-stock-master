import { withApi } from '@/lib/api';
import { countHistory } from '@/lib/v2/stock';

/** GET /api/v2/stock/counts?product_id=&limit= — histórico de contagens. */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const productId = q.get('product_id') ? Number(q.get('product_id')) : null;
  const limit = Math.min(Number(q.get('limit') ?? 100), 1000);
  return { counts: await countHistory({ productId, limit }) };
});
export const OPTIONS = withApi(async () => ({}));
