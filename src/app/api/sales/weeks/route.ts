import { withApi, ApiError } from '@/lib/api';
import { availableWeeks, weeksMatrix } from '@/lib/sales';

/**
 * GET /api/sales/weeks?weeks=4&familia=9
 * Per-product totals for the last N business weeks (Tue→Sun), one column per
 * week. `available` lists all synced weeks (for comparison pickers).
 */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const weeks = Math.min(Math.max(Number(q.get('weeks') ?? 4), 1), 26);
  const familiaRaw = q.get('familia');
  const familia = familiaRaw ? Number(familiaRaw) : undefined;
  if (familiaRaw && !Number.isInteger(familia)) {
    throw new ApiError(400, '"familia" must be a família code (integer)');
  }
  const [matrix, available] = await Promise.all([weeksMatrix(weeks, familia), availableWeeks()]);
  return { ...matrix, available };
});

export const OPTIONS = withApi(async () => ({}));
