import { sql, type Area, type MovementReason } from './db';

export interface MovementInput {
  productId: number;
  area: Area;
  delta: number;
  reason: MovementReason;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

/** Applies a stock movement: upserts the level and writes the ledger row. */
export async function applyMovement(m: MovementInput): Promise<void> {
  await sql()`
    INSERT INTO stock_levels (product_id, area, qty, updated_at)
    VALUES (${m.productId}, ${m.area}, ${m.delta}, now())
    ON CONFLICT (product_id, area)
    DO UPDATE SET qty = stock_levels.qty + ${m.delta}, updated_at = now()`;
  await sql()`
    INSERT INTO stock_movements (product_id, area, delta, reason, ref_type, ref_id, note, created_by)
    VALUES (${m.productId}, ${m.area}, ${m.delta}, ${m.reason},
            ${m.refType ?? null}, ${m.refId ?? null}, ${m.note ?? null}, ${m.createdBy ?? null})`;
}

export async function stockLevels(area?: Area) {
  if (area) {
    return sql()`
      SELECT p.id AS product_id, p.name, p.unit, p.min_level, l.area, l.qty, l.updated_at
      FROM stock_levels l
      JOIN products p ON p.id = l.product_id
      WHERE p.active AND l.area = ${area}
      ORDER BY p.name`;
  }
  return sql()`
    SELECT p.id AS product_id, p.name, p.unit, p.min_level, l.area, l.qty, l.updated_at
    FROM stock_levels l
    JOIN products p ON p.id = l.product_id
    WHERE p.active
    ORDER BY l.area, p.name`;
}

/** Products whose total stock (across areas) is at or below their min_level. */
export async function lowStockAlerts() {
  return sql()`
    SELECT p.id AS product_id, p.name, p.unit, p.area, p.min_level,
           COALESCE(SUM(l.qty), 0) AS qty
    FROM products p
    LEFT JOIN stock_levels l ON l.product_id = p.id
    WHERE p.active AND p.min_level IS NOT NULL
    GROUP BY p.id
    HAVING COALESCE(SUM(l.qty), 0) <= p.min_level
    ORDER BY COALESCE(SUM(l.qty), 0) / NULLIF(p.min_level, 0)`;
}

export async function movements(opts: {
  productId?: number;
  area?: Area;
  reason?: MovementReason;
  limit: number;
}) {
  return sql()`
    SELECT m.*, p.name AS product_name
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    WHERE (${opts.productId ?? null}::int IS NULL OR m.product_id = ${opts.productId ?? null})
      AND (${opts.area ?? null}::text IS NULL OR m.area = ${opts.area ?? null})
      AND (${opts.reason ?? null}::text IS NULL OR m.reason = ${opts.reason ?? null})
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${opts.limit}`;
}
