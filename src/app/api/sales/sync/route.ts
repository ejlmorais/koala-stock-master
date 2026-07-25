import { withApi, readJson, lisbonDate, isIsoDate, isClosedDay, ApiError } from '@/lib/api';
import { syncDay } from '@/lib/sales';

/**
 * Vercel Cron entry point (GET, authorized via CRON_SECRET): syncs yesterday,
 * unless yesterday was a closed weekday (Mondays by default).
 */
export const GET = withApi(async () => {
  const date = lisbonDate(1);
  if (isClosedDay(date)) {
    return { synced: [], skipped: [{ date, reason: 'closed day' }] };
  }
  const result = await syncDay(date);
  return { synced: [result], skipped: [] };
});

/**
 * Manual sync: { date } for one day or { from, to } for a range (inclusive,
 * max 62 days). Defaults to yesterday. Closed weekdays are skipped unless
 * force: true. Re-syncing a date is safe.
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  let dates: string[];
  if (body.from || body.to) {
    if (!isIsoDate(body.from) || !isIsoDate(body.to)) {
      throw new ApiError(400, '"from" and "to" must be YYYY-MM-DD');
    }
    const from = new Date(`${body.from}T00:00:00Z`);
    const to = new Date(`${body.to}T00:00:00Z`);
    if (from > to) throw new ApiError(400, '"from" must be <= "to"');
    dates = [];
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    if (dates.length > 62) throw new ApiError(400, 'range too large (max 62 days)');
  } else {
    const date = body.date ?? lisbonDate(1);
    if (!isIsoDate(date)) throw new ApiError(400, '"date" must be YYYY-MM-DD');
    dates = [date];
  }

  const synced = [];
  const skipped = [];
  for (const date of dates) {
    if (body.force !== true && isClosedDay(date)) {
      skipped.push({ date, reason: 'closed day' });
      continue;
    }
    synced.push(await syncDay(date));
  }
  return { synced, skipped };
});

export const OPTIONS = withApi(async () => ({}));
