import { withApi } from '@/lib/api';
import { weeklyVariations } from '@/lib/sales';

/** GET /api/sales/weekly?weeks=8 — weekly totals + per-product week-over-week change. */
export const GET = withApi(async (req) => {
  const weeks = Math.min(Number(req.nextUrl.searchParams.get('weeks') ?? 8), 52);
  return await weeklyVariations(weeks);
});

export const OPTIONS = withApi(async () => ({}));
