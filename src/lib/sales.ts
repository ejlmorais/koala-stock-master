import { sql } from './db';
import { fetchDailySales, type ZsDailySales } from './zonesoft';
import { applyMovement } from './stock';

export interface SyncResult {
  date: string;
  items: number;
  matchedProducts: number;
  stockMovements: number;
  grossTotal: number;
  parsed: boolean;
}

/**
 * Pulls one day of sales from Zonesoft and stores it. Idempotent: re-syncing a
 * date first reverses the stock decrements previously applied for it, then
 * replaces the items and re-applies stock.
 */
export async function syncDay(date: string): Promise<SyncResult> {
  const day: ZsDailySales = await fetchDailySales(date);
  return storeDay(day);
}

export async function storeDay(day: ZsDailySales): Promise<SyncResult> {
  const { date, items, grossTotal, raw } = day;

  // Reverse stock effects of a previous sync of this date.
  const prior = await sql()`
    SELECT id, product_id, area, delta FROM stock_movements
    WHERE reason = 'sale' AND ref_type = 'sale_day' AND ref_id = ${date}`;
  for (const m of prior) {
    await sql()`
      UPDATE stock_levels SET qty = qty - ${m.delta}, updated_at = now()
      WHERE product_id = ${m.product_id} AND area = ${m.area}`;
  }
  await sql()`
    DELETE FROM stock_movements
    WHERE reason = 'sale' AND ref_type = 'sale_day' AND ref_id = ${date}`;

  await sql()`
    INSERT INTO sales_days (sale_date, gross_total, items_count, raw, synced_at)
    VALUES (${date}, ${grossTotal}, ${items.length}, ${JSON.stringify(raw)}::jsonb, now())
    ON CONFLICT (sale_date) DO UPDATE
    SET gross_total = ${grossTotal}, items_count = ${items.length},
        raw = ${JSON.stringify(raw)}::jsonb, synced_at = now()`;
  await sql()`DELETE FROM sale_items WHERE sale_date = ${date}`;

  let matched = 0;
  let movementCount = 0;
  for (const item of items) {
    // A product links to Zonesoft via zonesoft_name holding either the ZSBMS
    // product name or its numeric code (the code survives renames).
    const products = await sql()`
      SELECT id, area, units_per_sale FROM products
      WHERE active AND (lower(zonesoft_name) = lower(${item.name})
                        OR zonesoft_name = ${item.code}
                        OR lower(name) = lower(${item.name}))
      LIMIT 1`;
    const product = products[0] as
      | { id: number; area: 'bar' | 'kitchen'; units_per_sale: string }
      | undefined;

    await sql()`
      INSERT INTO sale_items (sale_date, product_name, zs_code, qty, gross, product_id)
      VALUES (${date}, ${item.name}, ${item.code ?? null}, ${item.qty}, ${item.gross}, ${product?.id ?? null})
      ON CONFLICT (sale_date, product_name) DO UPDATE
      SET qty = sale_items.qty + ${item.qty}, gross = sale_items.gross + ${item.gross}`;

    if (product) {
      matched++;
      const delta = -item.qty * Number(product.units_per_sale);
      if (delta !== 0) {
        await applyMovement({
          productId: product.id,
          area: product.area,
          delta,
          reason: 'sale',
          refType: 'sale_day',
          refId: date,
          note: `Zonesoft: ${item.name} × ${item.qty}`,
        });
        movementCount++;
      }
    }
  }

  return {
    date,
    items: items.length,
    matchedProducts: matched,
    stockMovements: movementCount,
    grossTotal,
    parsed: items.length > 0,
  };
}

export async function salesDays(from: string, to: string) {
  return sql()`
    SELECT sale_date, gross_total, items_count, synced_at
    FROM sales_days
    WHERE sale_date BETWEEN ${from} AND ${to}
    ORDER BY sale_date DESC`;
}

export async function saleItems(from: string, to: string) {
  return sql()`
    SELECT sale_date, product_name, zs_code, qty, gross, product_id
    FROM sale_items
    WHERE sale_date BETWEEN ${from} AND ${to}
    ORDER BY sale_date DESC, gross DESC`;
}

export async function topSales(from: string, to: string, by: 'qty' | 'gross', limit: number) {
  if (by === 'qty') {
    return sql()`
      SELECT product_name, SUM(qty) AS qty, SUM(gross) AS gross, COUNT(DISTINCT sale_date) AS days
      FROM sale_items
      WHERE sale_date BETWEEN ${from} AND ${to}
      GROUP BY product_name
      ORDER BY SUM(qty) DESC
      LIMIT ${limit}`;
  }
  return sql()`
    SELECT product_name, SUM(qty) AS qty, SUM(gross) AS gross, COUNT(DISTINCT sale_date) AS days
    FROM sale_items
    WHERE sale_date BETWEEN ${from} AND ${to}
    GROUP BY product_name
    ORDER BY SUM(gross) DESC
    LIMIT ${limit}`;
}

/**
 * Per-week totals plus per-product change vs the previous week. The business
 * week runs Tuesday → Sunday (Monday is the closing day), so weeks are
 * bucketed from Tuesday: date_trunc('week', d - 1 day) + 1 day.
 */
export async function weeklyVariations(weeks: number) {
  const totals = await sql()`
    SELECT to_char(date_trunc('week', sale_date - interval '1 day') + interval '1 day',
                   'YYYY-MM-DD') AS week_start,
           SUM(gross_total) AS gross, SUM(items_count) AS items,
           COUNT(*) FILTER (WHERE items_count > 0) AS days_recorded
    FROM sales_days
    WHERE sale_date >= date_trunc('week', current_date - interval '1 day') + interval '1 day'
                       - (${weeks} || ' weeks')::interval
    GROUP BY 1
    ORDER BY 1 DESC`;

  const products = await sql()`
    WITH weekly AS (
      SELECT date_trunc('week', sale_date - interval '1 day') + interval '1 day' AS week,
             product_name,
             SUM(qty) AS qty, SUM(gross) AS gross
      FROM sale_items
      WHERE sale_date >= date_trunc('week', current_date - interval '1 day') + interval '1 day'
                         - interval '2 weeks'
      GROUP BY 1, 2
    ), cur AS (
      SELECT * FROM weekly
      WHERE week = date_trunc('week', current_date - interval '1 day') + interval '1 day'
    ), prev AS (
      SELECT * FROM weekly
      WHERE week = date_trunc('week', current_date - interval '1 day') + interval '1 day'
                   - interval '1 week'
    )
    SELECT COALESCE(c.product_name, p.product_name) AS product_name,
           COALESCE(c.qty, 0) AS qty_this_week,
           COALESCE(p.qty, 0) AS qty_last_week,
           COALESCE(c.gross, 0) AS gross_this_week,
           COALESCE(p.gross, 0) AS gross_last_week,
           CASE WHEN COALESCE(p.qty, 0) > 0
                THEN round(100.0 * (COALESCE(c.qty, 0) - p.qty) / p.qty, 1)
           END AS qty_change_pct
    FROM cur c
    FULL OUTER JOIN prev p USING (product_name)
    ORDER BY COALESCE(c.gross, 0) DESC`;

  return { weeks: totals, products };
}

/**
 * Outlier detection: for the given date (default: latest synced), flags
 * products whose quantity deviates from their trailing mean by >= `z` sample
 * standard deviations, plus a day-total check against the same weekday's
 * history. Products need >= 5 days of history to be scored.
 */
export async function outliers(opts: { date?: string; windowDays: number; z: number }) {
  const dateRows = opts.date
    ? [{ sale_date: opts.date }]
    : await sql()`SELECT to_char(MAX(sale_date), 'YYYY-MM-DD') AS sale_date FROM sales_days`;
  const date = dateRows[0]?.sale_date as string | null;
  if (!date) return { date: null, products: [], day_total: null };

  const products = await sql()`
    WITH hist AS (
      SELECT product_name, AVG(qty) AS mean, stddev_samp(qty) AS sd, COUNT(*) AS n
      FROM sale_items
      WHERE sale_date >= ${date}::date - (${opts.windowDays})::int
        AND sale_date < ${date}::date
      GROUP BY product_name
      HAVING COUNT(*) >= 5 AND stddev_samp(qty) > 0
    )
    SELECT i.product_name, i.qty, i.gross,
           round(h.mean, 2) AS mean_qty, round(h.sd, 2) AS sd_qty, h.n AS history_days,
           round((i.qty - h.mean) / h.sd, 2) AS z_score
    FROM sale_items i
    JOIN hist h USING (product_name)
    WHERE i.sale_date = ${date} AND ABS((i.qty - h.mean) / h.sd) >= ${opts.z}
    ORDER BY ABS((i.qty - h.mean) / h.sd) DESC`;

  const dayTotal = await sql()`
    WITH hist AS (
      SELECT AVG(gross_total) AS mean, stddev_samp(gross_total) AS sd, COUNT(*) AS n
      FROM sales_days
      WHERE EXTRACT(dow FROM sale_date) = EXTRACT(dow FROM ${date}::date)
        AND sale_date >= ${date}::date - 70 AND sale_date < ${date}::date
    )
    SELECT d.gross_total, round(h.mean, 2) AS mean_gross, round(h.sd, 2) AS sd_gross,
           h.n AS history_days,
           CASE WHEN h.sd > 0 THEN round((d.gross_total - h.mean) / h.sd, 2) END AS z_score
    FROM sales_days d, hist h
    WHERE d.sale_date = ${date}`;

  return { date, products, day_total: dayTotal[0] ?? null };
}
