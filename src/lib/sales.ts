import { sql } from './db';
import {
  fetchCatalog,
  fetchDailySales,
  fetchDailySalesWithSession,
  zonesoftLogin,
  type ZsDailySales,
} from './zonesoft';
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

/**
 * Syncs many days with a single Zonesoft login, refreshing the product
 * catalog (names + famílias) once at the start.
 */
export async function syncRange(dates: string[]): Promise<SyncResult[]> {
  const session = await zonesoftLogin();
  await syncCatalog(session);
  const results: SyncResult[] = [];
  for (const date of dates) {
    const day = await fetchDailySalesWithSession(session, date);
    results.push(await storeDay(day));
  }
  return results;
}

export async function syncCatalog(session?: Awaited<ReturnType<typeof zonesoftLogin>>) {
  const catalog = await fetchCatalog(session ?? (await zonesoftLogin()));
  if (catalog.length === 0) return 0;
  await sql()`
    INSERT INTO zs_products (code, name, familia_code, familia_name, updated_at)
    SELECT u.code, u.name, u.familia_code, u.familia_name, now()
    FROM unnest(${catalog.map((p) => p.code)}::text[],
                ${catalog.map((p) => p.name)}::text[],
                ${catalog.map((p) => p.familiaCode)}::int[],
                ${catalog.map((p) => p.familiaName)}::text[])
         AS u(code, name, familia_code, familia_name)
    ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, familia_code = EXCLUDED.familia_code,
        familia_name = EXCLUDED.familia_name, updated_at = now()`;
  return catalog.length;
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

  // Global kill switch: while 'sales_decrement' is off, sales are stored and
  // matched but never move stock (used until the team finishes the first real
  // count). Toggle via PUT /api/settings.
  const settings = await sql()`SELECT value FROM app_settings WHERE key = 'sales_decrement'`;
  const decrementEnabled = settings[0]?.value !== 'off';

  // A physical count is an absolute truth point: sales that happened BEFORE a
  // product's latest count are already reflected in it, so applying them
  // again would double-subtract. Only sales on/after the count date move stock.
  const countDates = new Map<number, string>();
  for (const row of await sql()`
    SELECT product_id,
           to_char(MAX(created_at AT TIME ZONE 'Europe/Lisbon'), 'YYYY-MM-DD') AS last_count
    FROM stock_counts GROUP BY product_id`) {
    countDates.set(row.product_id as number, row.last_count as string);
  }
  const stockApplies = (productId: number) => {
    if (!decrementEnabled) return false;
    const lastCount = countDates.get(productId);
    return !lastCount || date >= lastCount;
  };

  for (const item of items) {
    // Transformation recipe first: a sale product may consume several stock
    // products (Tosta Mista → pão + queijo + fiambre).
    const components = (await sql()`
      SELECT sc.product_id, sc.qty_per_sale, p.area
      FROM sale_components sc
      JOIN products p ON p.id = sc.product_id AND p.active
      WHERE sc.zs_code = ${item.code}`) as unknown as Array<{
      product_id: number;
      qty_per_sale: string;
      area: 'bar' | 'kitchen';
    }>;

    // Fallback: direct link via zonesoft_name (name or code) or exact name.
    const products =
      components.length > 0
        ? []
        : await sql()`
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

    if (components.length > 0) {
      matched++;
      for (const comp of components) {
        const delta = -item.qty * Number(comp.qty_per_sale);
        if (delta === 0 || !stockApplies(comp.product_id)) continue;
        await applyMovement({
          productId: comp.product_id,
          area: comp.area,
          delta,
          reason: 'sale',
          refType: 'sale_day',
          refId: date,
          note: `Zonesoft: ${item.name} × ${item.qty}`,
        });
        movementCount++;
      }
    } else if (product) {
      matched++;
      const delta = -item.qty * Number(product.units_per_sale);
      if (delta !== 0 && stockApplies(product.id)) {
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

/** Famílias that actually have sales, for filter dropdowns. */
export async function salesFamilies() {
  return sql()`
    SELECT DISTINCT p.familia_code AS code, p.familia_name AS name
    FROM sale_items i
    JOIN zs_products p ON p.code = i.zs_code
    WHERE p.familia_code IS NOT NULL
    ORDER BY p.familia_name`;
}

/**
 * Per-product totals for the last N business weeks (Tuesday → Sunday), one
 * column per week, optionally restricted to one família. Weeks are keyed by
 * their Tuesday start date.
 */
export async function weeksMatrix(weeks: number, familiaCode?: number) {
  const rows = await sql()`
    SELECT to_char(date_trunc('week', i.sale_date - interval '1 day') + interval '1 day',
                   'YYYY-MM-DD') AS week_start,
           i.product_name,
           p.familia_code, p.familia_name,
           SUM(i.qty) AS qty, SUM(i.gross) AS gross
    FROM sale_items i
    LEFT JOIN zs_products p ON p.code = i.zs_code
    WHERE i.sale_date >= date_trunc('week', current_date - interval '1 day') + interval '1 day'
                         - ((${weeks} - 1) || ' weeks')::interval
      AND (${familiaCode ?? null}::int IS NULL OR p.familia_code = ${familiaCode ?? null})
    GROUP BY 1, 2, 3, 4
    ORDER BY 2`;

  const weekSet = new Set<string>();
  const byProduct = new Map<
    string,
    {
      product_name: string;
      familia_code: number | null;
      familia_name: string | null;
      weeks: Record<string, { qty: number; gross: number }>;
      total_qty: number;
      total_gross: number;
    }
  >();
  for (const r of rows as Array<Record<string, unknown>>) {
    const week = r.week_start as string;
    weekSet.add(week);
    const name = r.product_name as string;
    let entry = byProduct.get(name);
    if (!entry) {
      entry = {
        product_name: name,
        familia_code: (r.familia_code as number) ?? null,
        familia_name: (r.familia_name as string) ?? null,
        weeks: {},
        total_qty: 0,
        total_gross: 0,
      };
      byProduct.set(name, entry);
    }
    const qty = Number(r.qty);
    const gross = Number(r.gross);
    entry.weeks[week] = { qty, gross };
    entry.total_qty += qty;
    entry.total_gross += gross;
  }

  const weekStarts = [...weekSet].sort().reverse();
  const products = [...byProduct.values()].sort((a, b) => b.total_gross - a.total_gross);
  const weekTotals: Record<string, { qty: number; gross: number }> = {};
  for (const w of weekStarts) weekTotals[w] = { qty: 0, gross: 0 };
  for (const p of products) {
    for (const [w, cell] of Object.entries(p.weeks)) {
      weekTotals[w].qty += cell.qty;
      weekTotals[w].gross += cell.gross;
    }
  }
  return { weeks: weekStarts, week_totals: weekTotals, products };
}

/**
 * Compares two business weeks (given their Tuesday start dates): per-product
 * qty/gross side by side with change, optionally restricted to one família.
 */
export async function compareWeeks(aStart: string, bStart: string, familiaCode?: number) {
  const side = async (start: string) =>
    sql()`
      SELECT i.product_name, p.familia_code, p.familia_name,
             SUM(i.qty) AS qty, SUM(i.gross) AS gross
      FROM sale_items i
      LEFT JOIN zs_products p ON p.code = i.zs_code
      WHERE i.sale_date >= ${start}::date
        AND i.sale_date < ${start}::date + 7
        AND (${familiaCode ?? null}::int IS NULL OR p.familia_code = ${familiaCode ?? null})
      GROUP BY 1, 2, 3`;

  const [aRows, bRows] = await Promise.all([side(aStart), side(bStart)]);
  const products = new Map<
    string,
    {
      product_name: string;
      familia_code: number | null;
      familia_name: string | null;
      a: { qty: number; gross: number };
      b: { qty: number; gross: number };
    }
  >();
  const add = (rows: typeof aRows, key: 'a' | 'b') => {
    for (const r of rows as Array<Record<string, unknown>>) {
      const name = r.product_name as string;
      let entry = products.get(name);
      if (!entry) {
        entry = {
          product_name: name,
          familia_code: (r.familia_code as number) ?? null,
          familia_name: (r.familia_name as string) ?? null,
          a: { qty: 0, gross: 0 },
          b: { qty: 0, gross: 0 },
        };
        products.set(name, entry);
      }
      entry[key] = { qty: Number(r.qty), gross: Number(r.gross) };
    }
  };
  add(aRows, 'a');
  add(bRows, 'b');

  const list = [...products.values()].sort((x, y) => y.b.gross + y.a.gross - (x.b.gross + x.a.gross));
  const total = (key: 'a' | 'b') => ({
    qty: list.reduce((s, p) => s + p[key].qty, 0),
    gross: list.reduce((s, p) => s + p[key].gross, 0),
  });
  return { a: { start: aStart, ...total('a') }, b: { start: bStart, ...total('b') }, products: list };
}

/** Tuesday start dates of business weeks that have synced sales, newest first. */
export async function availableWeeks() {
  return sql()`
    SELECT to_char(date_trunc('week', sale_date - interval '1 day') + interval '1 day',
                   'YYYY-MM-DD') AS week_start,
           to_char(MIN(sale_date), 'YYYY-MM-DD') AS first_day,
           to_char(MAX(sale_date), 'YYYY-MM-DD') AS last_day,
           SUM(gross_total) AS gross
    FROM sales_days
    GROUP BY 1
    ORDER BY 1 DESC`;
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
