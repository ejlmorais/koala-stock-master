import { isArea, type MovementReason } from '@/lib/db';
import { withApi, ApiError } from '@/lib/api';
import { movements } from '@/lib/stock';

const REASONS: MovementReason[] = ['manual', 'sale', 'order', 'adjustment'];

export const GET = withApi(async (req) => {
  const q = req.nextUrl.searchParams;
  const area = q.get('area');
  const reason = q.get('reason');
  if (area && !isArea(area)) throw new ApiError(400, 'area must be "bar" or "kitchen"');
  if (reason && !REASONS.includes(reason as MovementReason)) {
    throw new ApiError(400, `reason must be one of: ${REASONS.join(', ')}`);
  }
  const productId = q.get('product_id') ? Number(q.get('product_id')) : undefined;
  const limit = Math.min(Number(q.get('limit') ?? 100), 500);
  return {
    movements: await movements({
      productId,
      area: (area as 'bar' | 'kitchen') ?? undefined,
      reason: (reason as MovementReason) ?? undefined,
      limit,
    }),
  };
});

export const OPTIONS = withApi(async () => ({}));
