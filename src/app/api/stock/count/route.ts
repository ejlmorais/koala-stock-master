import { withApi, readJson, ApiError } from '@/lib/api';
import { submitCounts, latestCounts, type CountInput } from '@/lib/stock';

/**
 * POST /api/stock/count — batch counting session.
 * { counted_by?, counts: [{ product_id, qty, parts?, note? }] }
 * Each entry stores a stock_counts history row and adjusts the level.
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  if (!Array.isArray(body.counts) || body.counts.length === 0) {
    throw new ApiError(400, '"counts" must be a non-empty array');
  }
  const counts: CountInput[] = (body.counts as Record<string, unknown>[]).map((c, i) => {
    const productId = Number(c.product_id);
    const qty = Number(c.qty);
    if (!Number.isInteger(productId) || !Number.isFinite(qty) || qty < 0) {
      throw new ApiError(400, `counts[${i}] needs product_id and a qty >= 0`);
    }
    return {
      productId,
      qty,
      parts: (c.parts as Record<string, number>) ?? null,
      note: (c.note as string) ?? null,
    };
  });
  const results = await submitCounts(counts, (body.counted_by as string) ?? null);
  return { counted: results };
});

/** GET /api/stock/count — latest count per product (for "anterior: X"). */
export const GET = withApi(async () => {
  return { latest: await latestCounts() };
});

export const OPTIONS = withApi(async () => ({}));
