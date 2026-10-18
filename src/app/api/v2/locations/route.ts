import { withApi } from '@/lib/api';
import { listLocations } from '@/lib/v2/products';

export const GET = withApi(async () => ({ locations: await listLocations() }));
export const OPTIONS = withApi(async () => ({}));
