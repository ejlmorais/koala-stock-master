import { withApi } from '@/lib/api';
import { salesFamilies } from '@/lib/sales';

/** GET /api/sales/families — famílias (categories) that have sales. */
export const GET = withApi(async () => {
  return { families: await salesFamilies() };
});

export const OPTIONS = withApi(async () => ({}));
