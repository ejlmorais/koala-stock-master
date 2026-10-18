import { withApi } from '@/lib/api';
import { lowStockAlerts } from '@/lib/v2/stock';

/** GET /api/v2/stock/alerts — produtos no ponto de encomenda ou abaixo. */
export const GET = withApi(async () => ({ alerts: await lowStockAlerts() }));
export const OPTIONS = withApi(async () => ({}));
