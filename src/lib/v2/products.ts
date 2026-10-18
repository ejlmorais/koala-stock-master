import { sql } from '../db';
import { ApiError } from '../api';
import {
  AREAS,
  ORIGINS,
  nameCarriesPackaging,
  unitPrice,
  unitsPerPack,
  containersEquivalent,
  type Area,
  type CountLocation,
  type Origin,
  type ProductInput,
  type ProductRow,
  type Unit,
} from './model';

export async function listUnits(): Promise<Unit[]> {
  return (await sql()`SELECT * FROM v2.units ORDER BY dimension, code`) as unknown as Unit[];
}

export async function listLocations(): Promise<CountLocation[]> {
  return (await sql()`
    SELECT * FROM v2.count_locations WHERE active ORDER BY sort, id`) as unknown as CountLocation[];
}

/** Campos derivados que acompanham cada produto nas respostas. */
export function decorate(p: ProductRow & { qty?: string | null }) {
  const qty = Number(p.qty ?? 0);
  return {
    ...p,
    qty,
    units_per_pack: unitsPerPack(p),
    unit_price: unitPrice(p),
    containers_equivalent: containersEquivalent(p, qty),
    stock_value: (() => {
      const price = unitPrice(p);
      return price === null ? null : Math.round(qty * price * 100) / 100;
    })(),
  };
}

export async function listProducts(opts: { all?: boolean; area?: Area | null }) {
  const rows = (await sql()`
    SELECT p.*, l.qty
    FROM v2.products p
    LEFT JOIN v2.stock_levels l ON l.product_id = p.id
    WHERE (${opts.all === true} OR p.active)
      AND (${opts.area ?? null}::text IS NULL OR p.area = ${opts.area ?? null})
    ORDER BY p.area, p.category NULLS LAST, p.name`) as unknown as (ProductRow & { qty: string | null })[];
  return rows.map(decorate);
}

export async function getProduct(id: number) {
  const rows = (await sql()`
    SELECT p.*, l.qty
    FROM v2.products p
    LEFT JOIN v2.stock_levels l ON l.product_id = p.id
    WHERE p.id = ${id}`) as unknown as (ProductRow & { qty: string | null })[];
  if (!rows[0]) throw new ApiError(404, `produto ${id} não existe`);
  return decorate(rows[0]);
}

const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const numOrNull = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `"${field}" tem de ser um número`);
  return n;
};
const positive = (v: number | null, field: string) => {
  if (v !== null && v <= 0) throw new ApiError(400, `"${field}" tem de ser maior que zero`);
  return v;
};

/**
 * Valida o produto completo (criação, ou existente fundido com o patch) e
 * devolve a linha pronta a gravar. As regras espelham os CHECKs do esquema,
 * mas com mensagens em português.
 */
export async function validateProduct(raw: Record<string, unknown>): Promise<ProductInput> {
  const name = str(raw.name);
  if (!name) throw new ApiError(400, 'indique o nome do produto');
  if (nameCarriesPackaging(name)) {
    throw new ApiError(400, 'o nome não deve indicar unidade nem embalagem; isso define-se nos campos próprios');
  }
  const area = str(raw.area) ?? 'bar';
  if (!AREAS.includes(area as Area)) throw new ApiError(400, 'área tem de ser "bar" ou "kitchen"');
  const origin = str(raw.origin) ?? 'compra';
  if (!ORIGINS.includes(origin as Origin)) throw new ApiError(400, 'origem tem de ser "compra" ou "producao"');

  const units = await listUnits();
  const unit = str(raw.unit) ?? 'un';
  if (!units.some((u) => u.code === unit)) {
    throw new ApiError(400, `unidade "${unit}" não existe (${units.map((u) => u.code).join(', ')})`);
  }
  const unitLabel = unit === 'un' ? str(raw.unit_label)?.toLowerCase() ?? null : null;

  const containerName = str(raw.container_name);
  const containerQty = positive(numOrNull(raw.container_qty, 'container_qty'), 'container_qty');
  if ((containerName === null) !== (containerQty === null)) {
    throw new ApiError(400, 'o recipiente precisa de nome e de capacidade');
  }
  if (unit === 'un' && containerName !== null) {
    throw new ApiError(400, 'um produto contado à unidade não tem recipiente; a peça é a própria unidade');
  }

  let packName = str(raw.pack_name);
  let packQty = positive(numOrNull(raw.pack_qty, 'pack_qty'), 'pack_qty');
  let packNominal = positive(numOrNull(raw.pack_nominal_qty, 'pack_nominal_qty'), 'pack_nominal_qty');
  let packPrice = numOrNull(raw.pack_price_net, 'pack_price_net');
  if (origin === 'producao') {
    if (packName !== null || packQty !== null || packPrice !== null) {
      throw new ApiError(400, 'um produto produzido na cozinha não tem embalagem de compra');
    }
    packName = packQty = packNominal = packPrice = null;
  } else {
    if (packName === null) throw new ApiError(400, 'indique a embalagem de compra (use "Unidade" com 1 quando se compra à unidade)');
    if (packQty === null && packNominal === null) {
      throw new ApiError(400, 'indique quantas unidades traz a embalagem, ou a quantidade típica se o peso varia');
    }
    if (packPrice !== null && packPrice < 0) throw new ApiError(400, 'preço da embalagem não pode ser negativo');
  }

  const iva = numOrNull(raw.iva, 'iva');
  const minLevel = numOrNull(raw.min_level, 'min_level');
  if (minLevel !== null && minLevel < 0) throw new ApiError(400, 'ponto de encomenda não pode ser negativo');

  let priceNet = numOrNull(raw.price_net, 'price_net');
  const derived = unitPrice({ pack_qty: packQty, container_qty: containerQty, pack_price_net: packPrice, price_net: priceNet });
  priceNet = derived;

  let locations: number[] | null = null;
  if (Array.isArray(raw.count_locations) && raw.count_locations.length > 0) {
    const known = await listLocations();
    locations = raw.count_locations.map((v) => Number(v));
    for (const id of locations) {
      if (!known.some((l) => l.id === id)) throw new ApiError(400, `local de contagem ${id} não existe`);
    }
  }

  const aliases = Array.isArray(raw.supplier_aliases)
    ? raw.supplier_aliases.map((a) => String(a).trim()).filter(Boolean)
    : null;

  return {
    name,
    area: area as Area,
    category: str(raw.category),
    supplier: str(raw.supplier),
    supplier_aliases: aliases && aliases.length ? aliases : null,
    origin: origin as Origin,
    unit,
    unit_label: unitLabel,
    container_name: containerName,
    container_qty: containerQty,
    pack_name: packName,
    pack_qty: packQty,
    pack_nominal_qty: packNominal,
    pack_price_net: packPrice,
    price_net: priceNet,
    iva,
    min_level: minLevel,
    count_locations: locations,
    track_empties: raw.track_empties === true,
    needs_recount: raw.needs_recount === true,
    notes: str(raw.notes),
    active: raw.active === undefined ? true : raw.active !== false,
  };
}

export async function createProduct(raw: Record<string, unknown>) {
  const p = await validateProduct(raw);
  const rows = await sql()`
    INSERT INTO v2.products (name, area, category, supplier, supplier_aliases, origin, unit, unit_label,
      container_name, container_qty, pack_name, pack_qty, pack_nominal_qty, pack_price_net, price_net, iva,
      min_level, count_locations, track_empties, needs_recount, notes, active, legacy_id)
    VALUES (${p.name}, ${p.area}, ${p.category}, ${p.supplier}, ${p.supplier_aliases}, ${p.origin}, ${p.unit}, ${p.unit_label},
      ${p.container_name}, ${p.container_qty}, ${p.pack_name}, ${p.pack_qty}, ${p.pack_nominal_qty}, ${p.pack_price_net}, ${p.price_net}, ${p.iva},
      ${p.min_level}, ${p.count_locations}, ${p.track_empties}, ${p.needs_recount}, ${p.notes}, ${p.active},
      ${raw.legacy_id == null ? null : Number(raw.legacy_id)})
    ON CONFLICT (name) DO NOTHING
    RETURNING id`;
  if (!rows[0]) throw new ApiError(409, `já existe um produto chamado "${p.name}"`);
  const id = rows[0].id as number;
  await sql()`INSERT INTO v2.stock_levels (product_id, qty) VALUES (${id}, 0) ON CONFLICT DO NOTHING`;
  return getProduct(id);
}

/**
 * Atualiza um produto: funde o patch com a linha atual e valida o conjunto.
 * A unidade só muda por /convert-unit quando já há stock, contagens ou
 * receitas — aqui é recusada.
 */
export async function updateProduct(id: number, patch: Record<string, unknown>) {
  const current = await getProduct(id);
  if (patch.unit !== undefined && patch.unit !== current.unit) {
    const used = await sql()`
      SELECT (SELECT count(*) FROM v2.stock_movements WHERE product_id = ${id})
           + (SELECT count(*) FROM v2.recipes WHERE product_id = ${id}) AS n`;
    if (Number(used[0].n) > 0) {
      throw new ApiError(409, 'este produto já tem movimentos ou receitas: mude a unidade por "Mudar unidade", que converte tudo');
    }
  }
  const merged: Record<string, unknown> = { ...current, ...patch };
  const p = await validateProduct(merged);
  const dup = await sql()`SELECT id FROM v2.products WHERE name = ${p.name} AND id <> ${id}`;
  if (dup[0]) throw new ApiError(409, `já existe um produto chamado "${p.name}"`);
  await sql()`
    UPDATE v2.products SET
      name = ${p.name}, area = ${p.area}, category = ${p.category}, supplier = ${p.supplier},
      supplier_aliases = ${p.supplier_aliases}, origin = ${p.origin}, unit = ${p.unit}, unit_label = ${p.unit_label},
      container_name = ${p.container_name}, container_qty = ${p.container_qty},
      pack_name = ${p.pack_name}, pack_qty = ${p.pack_qty}, pack_nominal_qty = ${p.pack_nominal_qty},
      pack_price_net = ${p.pack_price_net}, price_net = ${p.price_net}, iva = ${p.iva},
      min_level = ${p.min_level}, count_locations = ${p.count_locations}, track_empties = ${p.track_empties},
      needs_recount = ${p.needs_recount}, notes = ${p.notes}, active = ${p.active}
    WHERE id = ${id}`;
  return getProduct(id);
}

export async function deactivateProduct(id: number) {
  await getProduct(id);
  await sql()`UPDATE v2.products SET active = false WHERE id = ${id}`;
  return { ok: true };
}
