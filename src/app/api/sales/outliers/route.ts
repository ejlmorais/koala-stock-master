import { withApi, isIsoDate, ApiError } from '@/lib/api';
import { outliers } from '@/lib/sales';

/**
 * GET /api/sales/outliers?date=YYYY-MM-DD&window=28&z=2
 * Defaults to the latest synced day.
 */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const date = q.get('date') ?? undefined;
  if (date && !isIsoDate(date)) throw new ApiError(400, '"date" must be YYYY-MM-DD');
  const windowDays = Math.min(Number(q.get('window') ?? 28), 365);
  const z = Number(q.get('z') ?? 2);
  return await outliers({ date, windowDays, z });
});

export const OPTIONS = withApi(async () => ({}));
