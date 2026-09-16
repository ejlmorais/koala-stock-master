import { sql } from '@/lib/db';
import { withApi, readJson, requireString, ApiError } from '@/lib/api';

const KNOWN_KEYS = ['sales_decrement', 'sales_decrement_categories', 'min_level_margin_pct'];

/** GET /api/settings — the switchboard (e.g. sales_decrement: on/off). */
export const GET = withApi(async () => {
  const rows = await sql()`SELECT key, value, updated_at FROM app_settings ORDER BY key`;
  return { settings: rows };
});

/** PUT /api/settings — { key, value }. sales_decrement: "on" | "off". */
export const PUT = withApi(async (req) => {
  const body = await readJson(req);
  const key = requireString(body.key, 'key');
  const value = requireString(body.value, 'value');
  if (!KNOWN_KEYS.includes(key)) {
    throw new ApiError(400, `unknown setting "${key}" (known: ${KNOWN_KEYS.join(', ')})`);
  }
  if (key === 'sales_decrement' && !['on', 'off'].includes(value)) {
    throw new ApiError(400, 'sales_decrement must be "on" or "off"');
  }
  if (key === 'sales_decrement_categories' && value.trim() !== '') {
    // Comma-separated product categories; reject typos against the catalog.
    const known = await sql()`SELECT DISTINCT category FROM products WHERE category IS NOT NULL`;
    const knownSet = new Set(known.map((r) => (r.category as string).toLowerCase()));
    for (const cat of value.split(',').map((c) => c.trim()).filter(Boolean)) {
      if (!knownSet.has(cat.toLowerCase())) {
        throw new ApiError(400, `unknown category "${cat}"`);
      }
    }
  }
  await sql()`
    INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = now()`;
  return { key, value };
});

export const OPTIONS = withApi(async () => ({}));
