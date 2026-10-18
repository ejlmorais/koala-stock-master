import { withApi } from '@/lib/api';
import { listUnits } from '@/lib/v2/products';

export const GET = withApi(async () => ({ units: await listUnits() }));
export const OPTIONS = withApi(async () => ({}));
