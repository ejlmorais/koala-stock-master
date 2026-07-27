import { withApi, isIsoDate, ApiError } from '@/lib/api';
import { compareWeeks } from '@/lib/sales';

/**
 * GET /api/sales/compare?a=2026-07-07&b=2026-07-21&familia=9
 * Compares two business weeks by their Tuesday start dates.
 */
export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const a = q.get('a');
  const b = q.get('b');
  if (!isIsoDate(a) || !isIsoDate(b)) {
    throw new ApiError(400, '"a" and "b" must be week start dates (YYYY-MM-DD)');
  }
  const familiaRaw = q.get('familia');
  const familia = familiaRaw ? Number(familiaRaw) : undefined;
  if (familiaRaw && !Number.isInteger(familia)) {
    throw new ApiError(400, '"familia" must be a família code (integer)');
  }
  return await compareWeeks(a, b, familia);
});

export const OPTIONS = withApi(async () => ({}));
