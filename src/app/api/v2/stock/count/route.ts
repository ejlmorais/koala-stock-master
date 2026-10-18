import { withApi, readJson, ApiError } from '@/lib/api';
import { latestCounts, submitCounts, type CountInput } from '@/lib/v2/stock';
import type { CountEntry } from '@/lib/v2/model';

/**
 * POST /api/v2/stock/count — sessão de contagem.
 * { counted_by?, counts: [{ product_id, entries: [{ location_id?, containers?, loose? }], empties?, note? }] }
 * O servidor calcula os totais na unidade de stock.
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  if (!Array.isArray(body.counts) || body.counts.length === 0) {
    throw new ApiError(400, '"counts" tem de ser uma lista com pelo menos um produto');
  }
  const counts: CountInput[] = (body.counts as Record<string, unknown>[]).map((c, i) => {
    const productId = Number(c.product_id);
    if (!Number.isInteger(productId)) throw new ApiError(400, `counts[${i}] precisa de product_id`);
    return {
      productId,
      entries: (c.entries as CountEntry[]) ?? [],
      empties: c.empties == null ? null : Number(c.empties),
      note: (c.note as string) ?? null,
    };
  });
  return { counted: await submitCounts(counts, (body.counted_by as string) ?? null) };
});

/** GET /api/v2/stock/count — última contagem por produto. */
export const GET = withApi(async () => ({ latest: await latestCounts() }));
export const OPTIONS = withApi(async () => ({}));
