/**
 * Stocks V2 — tipos e regras puras (sem base de dados).
 *
 * Três níveis por produto:
 *   unidade de stock  (unit)                      — onde o stock vive e as vendas descontam
 *   recipiente        (container_name/qty)        — o que se conta e recebe (Garrafa 70 cl)
 *   embalagem compra  (pack_name/qty/price_net)   — como o fornecedor vende (Grade 24)
 */
import { ApiError } from '../api';

export type Area = 'bar' | 'kitchen';
export type Origin = 'compra' | 'producao';
export type Dimension = 'count' | 'mass' | 'volume';
export type MovementReason =
  | 'count'
  | 'sale'
  | 'reception'
  | 'production'
  | 'waste'
  | 'manual'
  | 'import'
  | 'unit_change';

export const AREAS: Area[] = ['bar', 'kitchen'];
export const ORIGINS: Origin[] = ['compra', 'producao'];
export const ADJUST_REASONS: MovementReason[] = ['manual', 'waste'];

export interface Unit {
  code: string;
  dimension: Dimension;
  label_sg: string;
  label_pl: string;
}

export interface CountLocation {
  id: number;
  label: string;
  sort: number;
  active: boolean;
}

/** Linha de v2.products tal como vem da base (numéricos como string). */
export interface ProductRow {
  id: number;
  name: string;
  area: Area;
  category: string | null;
  supplier: string | null;
  supplier_aliases: string[] | null;
  origin: Origin;
  unit: string;
  unit_label: string | null;
  container_name: string | null;
  container_qty: string | null;
  pack_name: string | null;
  pack_qty: string | null;
  pack_nominal_qty: string | null;
  pack_price_net: string | null;
  price_net: string | null;
  iva: string | null;
  min_level: string | null;
  count_locations: number[] | null;
  track_empties: boolean;
  needs_recount: boolean;
  notes: string | null;
  active: boolean;
  legacy_id: number | null;
  created_at: string;
}

/** O que a API aceita para criar/editar um produto (já validado). */
export interface ProductInput {
  name: string;
  area: Area;
  category: string | null;
  supplier: string | null;
  supplier_aliases: string[] | null;
  origin: Origin;
  unit: string;
  unit_label: string | null;
  container_name: string | null;
  container_qty: number | null;
  pack_name: string | null;
  pack_qty: number | null;
  pack_nominal_qty: number | null;
  pack_price_net: number | null;
  price_net: number | null;
  iva: number | null;
  min_level: number | null;
  count_locations: number[] | null;
  track_empties: boolean;
  needs_recount: boolean;
  notes: string | null;
  active: boolean;
}

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

/** Unidades de stock que uma embalagem de compra traz (null = peso variável). */
export function unitsPerPack(p: {
  pack_qty: string | number | null;
  container_qty: string | number | null;
}): number | null {
  const packQty = num(p.pack_qty);
  if (packQty === null) return null;
  return packQty * (num(p.container_qty) ?? 1);
}

/** € s/IVA por unidade: derivado do preço da embalagem quando existe. */
export function unitPrice(p: {
  pack_qty: string | number | null;
  container_qty: string | number | null;
  pack_price_net: string | number | null;
  price_net: string | number | null;
}): number | null {
  const packPrice = num(p.pack_price_net);
  const perPack = unitsPerPack(p);
  if (packPrice !== null && perPack !== null && perPack > 0) {
    return Math.round((packPrice / perPack) * 1e6) / 1e6;
  }
  return num(p.price_net);
}

/** Uma entrada de contagem, tal como foi escrita. */
export interface CountEntry {
  location_id?: number | null;
  label?: string | null;
  /** recipientes (fração permitida: 1,3 garrafas) */
  containers?: number | null;
  /** soltos, na unidade de stock */
  loose?: number | null;
  /** total da entrada na unidade de stock (calculado no servidor) */
  qty?: number;
}

/**
 * Normaliza as entradas de uma contagem e calcula o total na unidade de
 * stock. Regras: `containers` só é aceite quando o produto tem recipiente;
 * valores em falta contam como 0; negativos são recusados.
 */
export function computeCount(
  product: { name: string; container_qty: string | number | null; count_locations: number[] | null },
  entries: CountEntry[]
): { entries: Required<Pick<CountEntry, 'qty'>>[] & CountEntry[]; qty: number } {
  const containerQty = num(product.container_qty);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ApiError(400, `${product.name}: a contagem precisa de pelo menos uma entrada`);
  }
  let total = 0;
  const clean = entries.map((e, i) => {
    const containers = num(e.containers ?? null);
    const loose = num(e.loose ?? null);
    if (containers !== null && containerQty === null) {
      throw new ApiError(400, `${product.name}: não tem recipiente, conte em unidades`);
    }
    if ((containers !== null && (containers < 0 || !Number.isFinite(containers))) ||
        (loose !== null && (loose < 0 || !Number.isFinite(loose)))) {
      throw new ApiError(400, `${product.name}: entrada ${i + 1} tem um valor negativo ou inválido`);
    }
    const qty = Math.round(((containers ?? 0) * (containerQty ?? 1) + (loose ?? 0)) * 1e4) / 1e4;
    total += qty;
    const out: CountEntry & { qty: number } = { qty };
    if (e.location_id != null) out.location_id = Number(e.location_id);
    if (e.label) out.label = String(e.label);
    if (containers !== null) out.containers = containers;
    if (loose !== null) out.loose = loose;
    return out;
  });
  return { entries: clean, qty: Math.round(total * 1e4) / 1e4 };
}

/** Sufixos de unidade/embalagem que o nome de um produto não pode levar. */
const NAME_SUFFIX =
  /\((kg|g|gr|un|uni|uni\.|unidade|unidades|embalagem|embalagens|caixa|balde|pacote|frasco|molho|porç[aã]o|porç[õo]es|vasilha|saco|grade|cuba|lata|barril)\b[^)]*\)\s*$/i;

export function nameCarriesPackaging(name: string): boolean {
  return NAME_SUFFIX.test(name);
}

/** Equivalente em recipientes, só para apresentação (null quando não há recipiente). */
export function containersEquivalent(
  p: { container_qty: string | number | null },
  qty: number
): number | null {
  const c = num(p.container_qty);
  return c ? Math.round((qty / c) * 100) / 100 : null;
}
