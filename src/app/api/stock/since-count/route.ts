import { withApi, ApiError } from '@/lib/api';
import { changesSinceLastCount } from '@/lib/stock';

/**
 * GET /api/stock/since-count?ids=1,2,3 — movements (grouped by reason) that
 * happened after each product's last count. Empty result = nothing moved,
 * the last count's per-local breakdown is still trustworthy.
 */
export const GET = withApi(async (req) => {
  const raw = new URL(req.url).searchParams.get('ids') ?? '';
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw new ApiError(400, '"ids" must be a comma-separated list of product ids');
  if (ids.length > 500) throw new ApiError(400, 'too many ids');
  return { changes: await changesSinceLastCount(ids) };
});

export const OPTIONS = withApi(async () => ({}));
