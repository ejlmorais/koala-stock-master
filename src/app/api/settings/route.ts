import { sql } from '@/lib/db';
import { withApi, readJson, requireString, ApiError } from '@/lib/api';

const KNOWN_KEYS = ['sales_decrement'];

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
  await sql()`
    INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = now()`;
  return { key, value };
});

export const OPTIONS = withApi(async () => ({}));
