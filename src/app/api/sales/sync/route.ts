import { withApi, readJson, lisbonDate, isIsoDate, isClosedDay, ApiError } from '@/lib/api';
import { syncRange } from '@/lib/sales';

export const maxDuration = 60;

/**
 * Vercel Cron entry point (GET, authorized via CRON_SECRET): syncs yesterday
 * and refreshes the product/família catalog, unless yesterday was a closed
 * weekday (Mondays by default).
 */
export const GET = withApi(async () => {
  const date = lisbonDate(1);
  if (isClosedDay(date)) {
    return { synced: [], skipped: [{ date, reason: 'closed day' }] };
  }
  const synced = await syncRange([date]);
  return { synced, skipped: [] };
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

  const skipped = [];
  const toSync = [];
  for (const date of dates) {
    if (body.force !== true && isClosedDay(date)) {
      skipped.push({ date, reason: 'closed day' });
      continue;
    }
    toSync.push(date);
  }
  // One Zonesoft login for the whole range; also refreshes the catalog.
  const synced = toSync.length > 0 ? await syncRange(toSync) : [];
  return { synced, skipped };
});

export const OPTIONS = withApi(async () => ({}));
