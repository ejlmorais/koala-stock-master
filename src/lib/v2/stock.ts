import { sql } from '../db';
import { ApiError } from '../api';
import { computeCount, type CountEntry, type MovementReason, type ProductRow } from './model';
import { decorate } from './products';

export interface MovementInput {
  productId: number;
  delta: number;
  reason: MovementReason;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  createdBy?: string | null;
  factor?: number | null;
}

/** Único escritor do ledger: soma ao nível e regista o movimento. */
export async function applyMovement(m: MovementInput): Promise<number> {
  await sql()`
    INSERT INTO v2.stock_levels (product_id, qty, updated_at)
    VALUES (${m.productId}, ${m.delta}, now())
    ON CONFLICT (product_id)
    DO UPDATE SET qty = v2.stock_levels.qty + ${m.delta}, updated_at = now()`;
  const rows = await sql()`
    INSERT INTO v2.stock_movements (product_id, delta, reason, ref_type, ref_id, note, created_by, factor)
    VALUES (${m.productId}, ${m.delta}, ${m.reason}, ${m.refType ?? null}, ${m.refId ?? null},
            ${m.note ?? null}, ${m.createdBy ?? null}, ${m.factor ?? null})
    RETURNING id`;
  return rows[0].id as number;
}

async function loadProduct(id: number): Promise<ProductRow & { qty: string | null }> {
  const rows = (await sql()`
    SELECT p.*, l.qty FROM v2.products p
    LEFT JOIN v2.stock_levels l ON l.product_id = p.id
    WHERE p.id = ${id} AND p.active`) as unknown as (ProductRow & { qty: string | null })[];
  if (!rows[0]) throw new ApiError(404, `produto ${id} não existe ou está inativo`);
  return rows[0];
}

export async function stockLevels(area?: string | null) {
  const rows = (await sql()`
    SELECT p.*, COALESCE(l.qty, 0) AS qty, l.updated_at AS level_updated_at
    FROM v2.products p
    LEFT JOIN v2.stock_levels l ON l.product_id = p.id
    WHERE p.active AND (${area ?? null}::text IS NULL OR p.area = ${area ?? null})
    ORDER BY p.area, p.category NULLS LAST, p.name`) as unknown as (ProductRow & { qty: string })[];
  return rows.map(decorate);
}

/** Produtos no ponto de encomenda ou abaixo. */
export async function lowStockAlerts() {
  const rows = (await sql()`
    SELECT p.*, COALESCE(l.qty, 0) AS qty
    FROM v2.products p
    LEFT JOIN v2.stock_levels l ON l.product_id = p.id
    WHERE p.active AND p.min_level IS NOT NULL AND COALESCE(l.qty, 0) <= p.min_level
    ORDER BY COALESCE(l.qty, 0) / NULLIF(p.min_level, 0), p.name`) as unknown as (ProductRow & { qty: string })[];
  return rows.map(decorate);
}

export interface CountInput {
  productId: number;
  entries: CountEntry[];
  empties?: number | null;
  note?: string | null;
}

/**
 * Grava uma sessão de contagem. O cliente envia o que foi escrito; o
 * servidor calcula o total na unidade de stock, guarda a contagem e aplica a
 * diferença ao nível com um movimento 'count'.
 */
export async function submitCounts(counts: CountInput[], countedBy: string | null) {
  const results = [];
  for (const c of counts) {
    const product = await loadProduct(c.productId);
    const { entries, qty } = computeCount(product, c.entries);
    const previous = Number(product.qty ?? 0);
    const delta = Math.round((qty - previous) * 1e4) / 1e4;
    const empties = c.empties == null ? null : Number(c.empties);
    if (empties !== null && (!Number.isFinite(empties) || empties < 0)) {
      throw new ApiError(400, `${product.name}: "vazios" inválido`);
    }
    const rows = await sql()`
      INSERT INTO v2.stock_counts (product_id, qty, entries, empties, previous_qty, note, counted_by)
      VALUES (${c.productId}, ${qty}, ${JSON.stringify(entries)}::jsonb, ${empties}, ${previous},
              ${c.note ?? null}, ${countedBy})
      RETURNING id`;
    const countId = rows[0].id as number;
    if (delta !== 0) {
      await applyMovement({
        productId: c.productId,
        delta,
        reason: 'count',
        refType: 'count',
        refId: String(countId),
        note: c.note ?? null,
        createdBy: countedBy,
      });
    }
    if (product.needs_recount) {
      await sql()`UPDATE v2.products SET needs_recount = false WHERE id = ${c.productId}`;
    }
    results.push({ product_id: c.productId, count_id: countId, qty, previous, delta });
  }
  return results;
}

/** Última contagem por produto (o «anterior» da página de contagem). */
export async function latestCounts() {
  return sql()`
    SELECT DISTINCT ON (product_id)
           product_id, qty, entries, empties, counted_by,
           to_char(created_at AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD') AS counted_on
    FROM v2.stock_counts
    ORDER BY product_id, created_at DESC`;
}

export async function countHistory(opts: { productId?: number | null; limit: number }) {
  return sql()`
    SELECT c.*, p.name AS product_name, p.unit, p.area, p.category
    FROM v2.stock_counts c
    JOIN v2.products p ON p.id = c.product_id
    WHERE (${opts.productId ?? null}::int IS NULL OR c.product_id = ${opts.productId ?? null})
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${opts.limit}`;
}

export async function movements(opts: {
  productId?: number | null;
  reason?: MovementReason | null;
  limit: number;
}) {
  return sql()`
    SELECT m.*, p.name AS product_name, p.unit, p.unit_label, p.area
    FROM v2.stock_movements m
    JOIN v2.products p ON p.id = m.product_id
    WHERE (${opts.productId ?? null}::int IS NULL OR m.product_id = ${opts.productId ?? null})
      AND (${opts.reason ?? null}::text IS NULL OR m.reason = ${opts.reason ?? null})
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${opts.limit}`;
}

/**
 * Acerto rápido: ±N na unidade, ou ±N recipientes (convertidos no servidor).
 */
export async function adjustStock(input: {
  productId: number;
  delta?: number | null;
  containers?: number | null;
  reason: MovementReason;
  note?: string | null;
  createdBy?: string | null;
}) {
  const product = await loadProduct(input.productId);
  let delta = input.delta ?? null;
  if (input.containers != null) {
    const c = Number(product.container_qty);
    if (!c) throw new ApiError(400, `${product.name}: não tem recipiente, acerte em unidades`);
    delta = (delta ?? 0) + input.containers * c;
  }
  if (delta === null || !Number.isFinite(delta) || delta === 0) {
    throw new ApiError(400, 'indique uma quantidade diferente de zero');
  }
  delta = Math.round(delta * 1e4) / 1e4;
  await applyMovement({
    productId: input.productId,
    delta,
    reason: input.reason,
    note: input.note ?? null,
    createdBy: input.createdBy ?? null,
  });
  const after = await loadProduct(input.productId);
  return { product_id: input.productId, delta, qty: Number(after.qty ?? 0) };
}
