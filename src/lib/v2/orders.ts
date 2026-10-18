import { sql } from '../db';
import { ApiError } from '../api';
import { applyMovement } from './stock';
import { unitsPerPack, type ProductRow } from './model';

export type OrderStatus = 'rascunho' | 'enviada' | 'recebida' | 'cancelada';

function pluralPt(word: string, n: number): string {
  const w = word.toLowerCase();
  if (n === 1) return w;
  if (/ão$/.test(w)) return w.replace(/ão$/, 'ões');
  if (/[rzl]$/.test(w)) return w + 'es';
  if (/m$/.test(w)) return w.replace(/m$/, 'ns');
  return /s$/.test(w) ? w : w + 's';
}

/** «2 grades», «2 garrafas + 21 cl», «10,5 kg» — para a nota do movimento. */
function describeReceived(packs: number, packName: string, loose: number, units: number, unit: string): string {
  const parts: string[] = [];
  if (packs) parts.push(`${packs} ${pluralPt(packName, packs)}`);
  if (loose) parts.push(`${loose} ${unit}`);
  if (parts.length === 0) parts.push(`${units} ${unit}`);
  return parts.join(' + ');
}
const STATUSES: OrderStatus[] = ['rascunho', 'enviada', 'recebida', 'cancelada'];

export interface OrderLineInput {
  product_id: number;
  /** embalagens pedidas (produtos com embalagem fixa) */
  packs?: number | null;
  /** quantidade na unidade de stock (peso variável, ou em vez de packs) */
  units?: number | null;
}

async function productsById(ids: number[]) {
  if (ids.length === 0) return new Map<number, ProductRow>();
  const rows = (await sql()`SELECT * FROM v2.products WHERE id = ANY(${ids})`) as unknown as ProductRow[];
  return new Map(rows.map((p) => [p.id, p]));
}

/** Converte uma linha pedida em unidades, com o snapshot da embalagem. */
function lineUnits(p: ProductRow, input: OrderLineInput) {
  const perPack = unitsPerPack(p);
  const packs = input.packs == null ? null : Number(input.packs);
  const units = input.units == null ? null : Number(input.units);
  if (p.origin === 'producao') throw new ApiError(400, `${p.name} é produzido na cozinha, não se encomenda`);
  if (perPack !== null) {
    if (packs === null || !(packs > 0)) {
      if (units !== null && units > 0) return { packs: null, units };
      throw new ApiError(400, `${p.name}: indique o número de embalagens (${p.pack_name ?? 'embalagem'})`);
    }
    return { packs, units: Math.round(packs * perPack * 1e4) / 1e4 };
  }
  // peso variável: pedido em embalagens com quantidade típica, ou diretamente na unidade
  if (units !== null && units > 0) return { packs: packs && packs > 0 ? packs : null, units };
  if (packs !== null && packs > 0 && p.pack_nominal_qty) {
    return { packs, units: Math.round(packs * Number(p.pack_nominal_qty) * 1e4) / 1e4 };
  }
  throw new ApiError(400, `${p.name}: indique a quantidade em ${p.unit} ou o número de embalagens`);
}

export async function listOrders(status?: OrderStatus | null) {
  return sql()`
    SELECT o.*,
           COUNT(l.id) AS line_count,
           COALESCE(SUM(CASE WHEN l.not_coming THEN 0 ELSE l.units END), 0) AS units_total,
           COALESCE(SUM(CASE WHEN l.not_coming THEN 0 ELSE l.received_units END), 0) AS received_total,
           COALESCE(SUM(l.packs * NULLIF(p.pack_price_net, 0)), 0) AS value_estimate
    FROM v2.orders o
    LEFT JOIN v2.order_lines l ON l.order_id = o.id
    LEFT JOIN v2.products p ON p.id = l.product_id
    WHERE (${status ?? null}::text IS NULL OR o.status = ${status ?? null})
    GROUP BY o.id
    ORDER BY (o.status = 'recebida' OR o.status = 'cancelada'), o.expected_on NULLS LAST, o.created_at DESC`;
}

export async function getOrder(id: number) {
  const orders = await sql()`SELECT * FROM v2.orders WHERE id = ${id}`;
  if (!orders[0]) throw new ApiError(404, `encomenda ${id} não existe`);
  const lines = await sql()`
    SELECT l.*, p.name AS product_name, p.unit, p.unit_label, p.container_name,
           p.supplier, p.supplier_alt, p.pack_nominal_qty, p.pack_price_net
    FROM v2.order_lines l
    JOIN v2.products p ON p.id = l.product_id
    WHERE l.order_id = ${id}
    ORDER BY p.name`;
  const receptions = await sql()`
    SELECT r.*, (SELECT json_agg(json_build_object('order_line_id', rl.order_line_id, 'packs', rl.packs, 'loose', rl.loose, 'units', rl.units))
                 FROM v2.reception_lines rl WHERE rl.reception_id = r.id) AS lines
    FROM v2.receptions r WHERE r.order_id = ${id} ORDER BY r.received_at`;
  const order = orders[0] as unknown as {
    id: number; supplier: string; status: OrderStatus; external_ref: string | null; expected_on: string | null;
    note: string | null; created_by: string | null; created_at: string; ordered_at: string | null; closed_at: string | null;
  };
  return { ...order, lines, receptions };
}

/** Valida e converte as linhas ANTES de tocar na base (nenhuma encomenda fica órfã). */
async function prepareLines(inputs: OrderLineInput[]) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ApiError(400, 'a encomenda precisa de pelo menos uma linha');
  const products = await productsById(inputs.map((l) => Number(l.product_id)));
  return inputs.map((input) => {
    const p = products.get(Number(input.product_id));
    if (!p) throw new ApiError(400, `produto ${input.product_id} não existe`);
    return { p, ...lineUnits(p, input) };
  });
}

async function insertLines(orderId: number, prepared: Awaited<ReturnType<typeof prepareLines>>) {
  for (const { p, packs, units } of prepared) {
    await sql()`
      INSERT INTO v2.order_lines (order_id, product_id, pack_name, pack_qty, container_qty, packs, units)
      VALUES (${orderId}, ${p.id}, ${p.pack_name}, ${p.pack_qty}, ${p.container_qty}, ${packs}, ${units})`;
  }
}

export async function createOrder(input: {
  supplier: string;
  status?: OrderStatus;
  expected_on?: string | null;
  note?: string | null;
  created_by?: string | null;
  external_ref?: string | null;
  lines: OrderLineInput[];
}) {
  if (!input.supplier?.trim()) throw new ApiError(400, 'indique o fornecedor');
  const prepared = await prepareLines(input.lines);
  const status: OrderStatus = input.status === 'enviada' ? 'enviada' : 'rascunho';
  const rows = await sql()`
    INSERT INTO v2.orders (supplier, status, expected_on, note, created_by, external_ref, ordered_at)
    VALUES (${input.supplier.trim()}, ${status}, ${input.expected_on ?? null}, ${input.note ?? null},
            ${input.created_by ?? null}, ${input.external_ref ?? null}, ${status === 'enviada' ? new Date().toISOString() : null})
    RETURNING id`;
  const id = rows[0].id as number;
  await insertLines(id, prepared);
  return getOrder(id);
}

export async function updateOrder(
  id: number,
  patch: { supplier?: string; status?: OrderStatus; expected_on?: string | null; note?: string | null; lines?: OrderLineInput[] },
) {
  const order = await getOrder(id);
  const hasReceptions = (order.receptions as unknown[]).length > 0;
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new ApiError(400, 'estado inválido');
  if (patch.status === 'recebida') throw new ApiError(400, 'use a receção para marcar como recebida');
  if (hasReceptions && (patch.lines || patch.status === 'cancelada' || patch.status === 'rascunho')) {
    throw new ApiError(409, 'esta encomenda já tem receções; reverta-as primeiro');
  }
  await sql()`
    UPDATE v2.orders SET
      supplier = COALESCE(${patch.supplier ?? null}, supplier),
      status = COALESCE(${patch.status ?? null}, status),
      expected_on = CASE WHEN ${patch.expected_on !== undefined} THEN ${patch.expected_on ?? null}::date ELSE expected_on END,
      note = CASE WHEN ${patch.note !== undefined} THEN ${patch.note ?? null} ELSE note END,
      ordered_at = CASE WHEN ${patch.status ?? null} = 'enviada' AND ordered_at IS NULL THEN now() ELSE ordered_at END,
      closed_at = CASE WHEN ${patch.status ?? null} = 'cancelada' THEN now() ELSE closed_at END
    WHERE id = ${id}`;
  if (patch.lines) {
    const prepared = await prepareLines(patch.lines);
    await sql()`DELETE FROM v2.order_lines WHERE order_id = ${id}`;
    await insertLines(id, prepared);
  }
  return getOrder(id);
}

export interface ReceptionLineInput {
  order_line_id: number;
  packs?: number | null;
  loose?: number | null;
  /** quantidade direta na unidade (peso variável) */
  units?: number | null;
  not_coming?: boolean;
}

/**
 * Regista uma receção: por linha, embalagens + soltos (ou kg nos variáveis),
 * lança um movimento 'reception' por linha e acumula received_units. A
 * encomenda fecha quando todas as linhas estão completas ou «não vem».
 */
export async function receiveOrder(
  id: number,
  input: { received_by?: string | null; invoice_ref?: string | null; note?: string | null; lines: ReceptionLineInput[] },
) {
  const order = await getOrder(id);
  if (order.status === 'cancelada') throw new ApiError(409, 'encomenda cancelada');
  if (order.status === 'recebida') throw new ApiError(409, 'encomenda já totalmente recebida');
  const lineById = new Map((order.lines as Array<Record<string, unknown>>).map((l) => [Number(l.id), l]));

  const rec = await sql()`
    INSERT INTO v2.receptions (order_id, received_by, invoice_ref, note)
    VALUES (${id}, ${input.received_by ?? null}, ${input.invoice_ref ?? null}, ${input.note ?? null})
    RETURNING id`;
  const receptionId = rec[0].id as number;

  let any = false;
  for (const rl of input.lines) {
    const line = lineById.get(Number(rl.order_line_id));
    if (!line) throw new ApiError(400, `linha ${rl.order_line_id} não pertence a esta encomenda`);
    if (rl.not_coming) {
      await sql()`UPDATE v2.order_lines SET not_coming = true WHERE id = ${line.id}`;
      continue;
    }
    const perPack = line.pack_qty == null ? null : Number(line.pack_qty) * (line.container_qty == null ? 1 : Number(line.container_qty));
    const packs = rl.packs == null ? 0 : Number(rl.packs);
    const loose = rl.loose == null ? 0 : Number(rl.loose);
    let units = rl.units == null ? null : Number(rl.units);
    if (units === null) units = (perPack ?? 0) * packs + loose;
    if (!Number.isFinite(units) || units < 0) throw new ApiError(400, `${line.product_name}: quantidade inválida`);
    if (units === 0) continue;
    units = Math.round(units * 1e4) / 1e4;
    const ins = await sql()`
      INSERT INTO v2.reception_lines (reception_id, order_line_id, packs, loose, units)
      VALUES (${receptionId}, ${line.id}, ${rl.packs ?? null}, ${rl.loose ?? null}, ${units})
      RETURNING id`;
    await applyMovement({
      productId: Number(line.product_id),
      delta: units,
      reason: 'reception',
      refType: 'reception_line',
      refId: String(ins[0].id),
      note: `${order.supplier}: ${describeReceived(packs, String(line.pack_name ?? 'embalagem'), loose, units, String(line.unit))}`,
      createdBy: input.received_by ?? null,
    });
    await sql()`UPDATE v2.order_lines SET received_units = received_units + ${units}, not_coming = false WHERE id = ${line.id}`;
    any = true;
  }
  if (!any && !input.lines.some((l) => l.not_coming)) {
    await sql()`DELETE FROM v2.receptions WHERE id = ${receptionId}`;
    throw new ApiError(400, 'nada recebido');
  }

  // Linha completa: «não vem», recebeu o pedido, ou é de peso variável e já recebeu algo.
  const pending = await sql()`
    SELECT count(*) AS n FROM v2.order_lines
    WHERE order_id = ${id} AND NOT not_coming AND received_units < units
      AND NOT (pack_qty IS NULL AND received_units > 0)`;
  if (Number(pending[0].n) === 0) {
    await sql()`UPDATE v2.orders SET status = 'recebida', closed_at = now() WHERE id = ${id}`;
  } else if (order.status === 'rascunho') {
    await sql()`UPDATE v2.orders SET status = 'enviada', ordered_at = COALESCE(ordered_at, now()) WHERE id = ${id}`;
  }
  return getOrder(id);
}

/** Reverte uma receção: movimentos simétricos, linhas repostas, encomenda reaberta. */
export async function reverseReception(receptionId: number, by?: string | null) {
  const recs = await sql()`SELECT * FROM v2.receptions WHERE id = ${receptionId}`;
  if (!recs[0]) throw new ApiError(404, 'receção não existe');
  const lines = await sql()`
    SELECT rl.*, ol.product_id, ol.order_id FROM v2.reception_lines rl
    JOIN v2.order_lines ol ON ol.id = rl.order_line_id WHERE rl.reception_id = ${receptionId}`;
  for (const l of lines) {
    await applyMovement({
      productId: Number(l.product_id),
      delta: -Number(l.units),
      reason: 'reception',
      refType: 'reception_line_reverse',
      refId: String(l.id),
      note: 'receção revertida',
      createdBy: by ?? null,
    });
    await sql()`UPDATE v2.order_lines SET received_units = GREATEST(received_units - ${l.units}, 0) WHERE id = ${l.order_line_id}`;
  }
  const orderId = recs[0].order_id as number;
  await sql()`DELETE FROM v2.receptions WHERE id = ${receptionId}`;
  await sql()`UPDATE v2.orders SET status = 'enviada', closed_at = NULL WHERE id = ${orderId} AND status = 'recebida'`;
  return getOrder(orderId);
}
