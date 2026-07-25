import { withApi, lisbonDate, isIsoDate, ApiError } from '@/lib/api';
import { salesDays, saleItems } from '@/lib/sales';

/**
 * GET /api/sales?from=YYYY-MM-DD&to=YYYY-MM-DD[&items=true]
 * Defaults to the last 30 days.
 */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const from = q.get('from') ?? lisbonDate(30);
  const to = q.get('to') ?? lisbonDate(0);
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new ApiError(400, '"from" and "to" must be YYYY-MM-DD');
  }
  const days = await salesDays(from, to);
  if (q.get('items') === 'true') {
    return { from, to, days, items: await saleItems(from, to) };
  }
  return { from, to, days };
});

export const OPTIONS = withApi(async () => ({}));
