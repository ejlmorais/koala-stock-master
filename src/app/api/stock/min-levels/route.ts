import { withApi, readJson } from '@/lib/api';
import { recomputeMinLevels } from '@/lib/stock';

/**
 * POST /api/stock/min-levels — recalcula os mínimos semanais a partir do
 * consumo das últimas 4 semanas (70/30, margem de segurança configurável).
 * Body: { dry?: boolean } — dry devolve as alterações sem gravar.
 */
export const POST = withApi(async (req) => {
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  return await recomputeMinLevels(body.dry === true);
});

export const OPTIONS = withApi(async () => ({}));
