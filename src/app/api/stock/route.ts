import { isArea, type Area } from '@/lib/db';
import { withApi, ApiError } from '@/lib/api';
import { stockLevels } from '@/lib/stock';

export const GET = withApi(async (req) => {
  const raw = req.nextUrl.searchParams.get('area');
  let area: Area | undefined;
  if (raw != null) {
    if (!isArea(raw)) throw new ApiError(400, 'area must be "bar" or "kitchen"');
    area = raw;
  }
  return { stock: await stockLevels(area) };
});

export const OPTIONS = withApi(async () => ({}));
