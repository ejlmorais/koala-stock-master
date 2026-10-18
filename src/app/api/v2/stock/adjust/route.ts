import { withApi, readJson, ApiError } from '@/lib/api';
import { adjustStock } from '@/lib/v2/stock';
import { ADJUST_REASONS, type MovementReason } from '@/lib/v2/model';

/**
 * POST /api/v2/stock/adjust
 * { product_id, delta? | containers?, reason: 'manual'|'waste', note?, created_by? }
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  const productId = Number(body.product_id);
  if (!Number.isInteger(productId)) throw new ApiError(400, '"product_id" é obrigatório');
  const reason = (body.reason as MovementReason) ?? 'manual';
  if (!ADJUST_REASONS.includes(reason)) throw new ApiError(400, `motivo tem de ser ${ADJUST_REASONS.join(' ou ')}`);
  return adjustStock({
    productId,
    delta: body.delta == null ? null : Number(body.delta),
    containers: body.containers == null ? null : Number(body.containers),
    reason,
    note: (body.note as string) ?? null,
    createdBy: (body.created_by as string) ?? null,
  });
});
export const OPTIONS = withApi(async () => ({}));
