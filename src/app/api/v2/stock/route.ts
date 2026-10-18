import { withApi } from '@/lib/api';
import { stockLevels } from '@/lib/v2/stock';

/** GET /api/v2/stock?area=bar — níveis atuais com campos derivados. */
export const GET = withApi(async (req) => ({
  stock: await stockLevels(req.nextUrl.searchParams.get('area')),
}));
export const OPTIONS = withApi(async () => ({}));
