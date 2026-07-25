import { sql, isArea } from '@/lib/db';
import { withApi, readJson, requireString, ApiError } from '@/lib/api';

export const GET = withApi(async (req) => {
  const area = req.nextUrl.searchParams.get('area');
  const includeInactive = req.nextUrl.searchParams.get('all') === 'true';
  const rows = await sql()`
    SELECT p.*, COALESCE(SUM(l.qty), 0) AS total_qty
    FROM products p
    LEFT JOIN stock_levels l ON l.product_id = p.id
    WHERE (${includeInactive} OR p.active)
      AND (${area}::text IS NULL OR p.area = ${area})
    GROUP BY p.id
    ORDER BY p.area, p.name`;
  return { products: rows };
});

export const POST = withApi(async (req) => {
  const body = await readJson(req);
  const name = requireString(body.name, 'name');
  const area = body.area ?? 'bar';
  if (!isArea(area)) throw new ApiError(400, 'area must be "bar" or "kitchen"');
  const rows = await sql()`
    INSERT INTO products (name, unit, area, zonesoft_name, units_per_sale, min_level)
    VALUES (${name}, ${(body.unit as string) ?? 'un'}, ${area},
            ${(body.zonesoft_name as string) ?? null},
            ${(body.units_per_sale as number) ?? 1},
            ${(body.min_level as number) ?? null})
    ON CONFLICT (name) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new ApiError(409, `product "${name}" already exists`);
  return { product: rows[0] };
});

export const OPTIONS = withApi(async () => ({}));
