import { withApi } from '@/lib/api';
import { movements } from '@/lib/v2/stock';
import type { MovementReason } from '@/lib/v2/model';

/** GET /api/v2/stock/movements?product_id=&reason=&limit= — o ledger. */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const productId = q.get('product_id') ? Number(q.get('product_id')) : null;
  const limit = Math.min(Number(q.get('limit') ?? 100), 1000);
  return { movements: await movements({ productId, reason: q.get('reason') as MovementReason | null, limit }) };
});
export const OPTIONS = withApi(async () => ({}));
