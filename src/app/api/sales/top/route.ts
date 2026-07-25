import { withApi, lisbonDate, isIsoDate, ApiError } from '@/lib/api';
import { topSales } from '@/lib/sales';

/**
 * GET /api/sales/top?days=7&by=qty|gross&limit=20
 * or explicit ?from=&to= range.
 */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const days = Number(q.get('days') ?? 7);
  const from = q.get('from') ?? lisbonDate(days);
  const to = q.get('to') ?? lisbonDate(0);
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new ApiError(400, '"from" and "to" must be YYYY-MM-DD');
  }
  const by = q.get('by') === 'gross' ? 'gross' : 'qty';
  const limit = Math.min(Number(q.get('limit') ?? 20), 100);
  return { from, to, by, top: await topSales(from, to, by, limit) };
});

export const OPTIONS = withApi(async () => ({}));
