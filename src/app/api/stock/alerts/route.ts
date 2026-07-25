import { withApi } from '@/lib/api';
import { lowStockAlerts } from '@/lib/stock';

export const GET = withApi(async () => {
  return { alerts: await lowStockAlerts() };
});

export const OPTIONS = withApi(async () => ({}));
