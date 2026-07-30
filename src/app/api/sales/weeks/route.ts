import { withApi, ApiError } from '@/lib/api';
import { availableWeeks, weeksMatrix } from '@/lib/sales';

/**
 * GET /api/sales/weeks?weeks=4&familia=9&avg=ytd|8
 * Per-product totals for the last N business weeks (Tue→Sun), one column per
 * week, plus a weekly average per product ('ytd' or trailing N weeks).
 * `available` lists all synced weeks (for comparison pickers).
 */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const weeks = Math.min(Math.max(Number(q.get('weeks') ?? 4), 1), 26);
  const familiaRaw = q.get('familia');
  const familia = familiaRaw ? Number(familiaRaw) : undefined;
  if (familiaRaw && !Number.isInteger(familia)) {
    throw new ApiError(400, '"familia" must be a família code (integer)');
  }
  const avgRaw = q.get('avg') ?? 'ytd';
  const avgBasis: 'ytd' | number = avgRaw === 'ytd' ? 'ytd' : Number(avgRaw);
  if (avgBasis !== 'ytd' && (!Number.isInteger(avgBasis) || avgBasis < 1 || avgBasis > 52)) {
    throw new ApiError(400, '"avg" must be "ytd" or a number of weeks (1-52)');
  }
  const [matrix, available] = await Promise.all([
    weeksMatrix(weeks, familia, avgBasis),
    availableWeeks(),
  ]);
  return { ...matrix, available };
});

export const OPTIONS = withApi(async () => ({}));
