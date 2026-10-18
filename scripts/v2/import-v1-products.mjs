#!/usr/bin/env node
/**
 * Importação PROVISÓRIA do catálogo V1 (public.products) para v2.products.
 *
 *   node scripts/v2/import-v1-products.mjs          # relatório, não escreve
 *   node scripts/v2/import-v1-products.mjs --apply  # escreve (substitui o catálogo v2)
 *
 * Deduz unidade de stock, recipiente e embalagem de compra a partir de
 * unit / pack_size / packaging / count_parts / notes da V1, por regras de
 * arquétipo mais uma lista curta de casos conhecidos. Tudo o que for
 * duvidoso fica assinalado em `notes` com «REVER: …». O stock NÃO é
 * importado: todos os produtos nascem com needs_recount = true.
 * Recusa-se a correr se o v2 já tiver movimentos de stock.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
const APPLY = process.argv.includes('--apply');
const sql = neon(process.env.DATABASE_URL);

// ── Regras auxiliares ──────────────────────────────────────────────────────
const SUFFIX =
  /\s*\((kg|g|gr|un|uni|uni\.|unidade|unidades|embalagem|embalagens|caixa|balde|pacote|frasco|molho|porç[aã]o|porç[õo]es|porções cozinhadas|vasilha|saco|grade|cuba|lata|barril|grf)\b[^)]*\)\s*$/i;
// Tamanhos que identificam a variante ficam no nome (Macieira 1L, Heineken 25cl);
// só perdem os parênteses: «Óleo Alimentar (5L)» → «Óleo Alimentar 5L».
const SIZE_IN_NAME = /\s*\((\d+(?:[.,]\d+)?\s*(?:kg|g|gr|l|cl|ml))\)\s*$/i;
const cleanPackName = (s) =>
  (s ?? '')
    .replace(/\s*[±~]?\d+(?:[.,]\d+)?\s*(?:kg|g|gr|l|cl|ml)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
const UNIT_MAP = { un: 'un', uni: 'un', 'uni.': 'un', g: 'g', kg: 'kg', cl: 'cl', L: 'L', fatia: 'fatia', 'porção': 'porção', 'porções': 'porção', 'porções cozinhadas': 'porção' };
const PACK_NAMES = ['Unidade', 'Grade', 'Caixa', 'Embalagem', 'Garrafa', 'Lata', 'Balde', 'Saco', 'Pacote', 'Frasco', 'Rolo', 'Barril', 'Botija', 'Cuba', 'Molho'];

/** Casos conhecidos que as regras não apanham bem: nome V1 → ajustes. */
const OVERRIDES = {
  'Bifana (embalagem)': { name: 'Bifana cozinhada', origin: 'producao', unit: 'porção' },
  'Moelas (porções cozinhadas)': { name: 'Moelas cozinhadas', origin: 'producao', unit: 'porção' },
  'Chouriço (porção)': { name: 'Chouriço assado', origin: 'producao', unit: 'porção' },
  'Pickles (balde)': { skip: 'fundir em Pickles' },
  'Alface Iceberg (uni)': { name: 'Alface Iceberg', unit: 'un', unit_label: 'cabeça', container: null, pack: ['Unidade', 1] },
  'Tomate Runner (uni)': { unit: 'un', unit_label: 'tomate', container: null, pack: ['Caixa', null, 6] },
  'Pepino (uni)': { unit: 'un', unit_label: 'pepino', container: null, pack: ['Caixa', null, 4] },
  'Espinafre (embalagem)': { name: 'Espinafre', unit: 'g', container: null, pack: ['Embalagem', null, 500] },
  'Sal Fino (500gr)': { name: 'Sal Fino', unit: 'un', unit_label: 'pacote', pack: ['Unidade', 1] },
  'Peito de Frango (vasilha)': { name: 'Peito de Frango', unit: 'kg', pack: ['Vasilha', null, 2] },
  'Gás Dióxido Carbono 10kg': { name: 'Gás Dióxido Carbono', unit: 'un', unit_label: 'botija', pack: ['Botija', 1], track_empties: true },
  'Leite (Bar)': { unit: 'L', container: ['Pacote', 1], pack: ['Embalagem', 6] },
  'Sumos Staff (grf)': { name: 'Sumos Staff', unit: 'un', unit_label: 'garrafa', pack: ['Unidade', 1] },
  'Fiambre': { container: ['Embalagem', 30], pack: ['Embalagem', 1] },
  'Pão Tosta (pacote)': { name: 'Pão Tosta', container: ['Pacote', 18], pack: ['Pacote', 1] },
  'Copos Heineken (25cl)': { name: 'Copos Heineken 25cl' },
  'Copos Heineken (50cl)': { name: 'Copos Heineken 50cl' },
  'Queijo Chévre (180gr)': { name: 'Queijo Chévre 180g' },
  'Nachos (500gr)': { name: 'Nachos', unit: 'un', unit_label: 'saco', container: null, pack: ['Caixa', 6] },
  'Chocolate Barra (200gr)': { name: 'Chocolate Barra', unit: 'un', unit_label: 'barra', container: null, pack: ['Caixa', 2] },
};

const isProducao = (p) =>
  /vem da produção/i.test(p.notes ?? '') || p.supplier === 'Produção' || p.category === 'Produção';

/** Volume da garrafa (cl) de uma espirituosa: notes «70cl», packaging «Garrafa 1L», nome «1L / 50cl». */
function bottleCl(p) {
  const src = `${p.notes ?? ''} ${p.packaging?.order_name ?? ''} ${p.name}`;
  const m = src.match(/(\d+(?:[.,]\d+)?)\s*(cl|l)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return m[2].toLowerCase() === 'l' ? n * 100 : n;
}

function derive(p) {
  const o = OVERRIDES[p.name] ?? {};
  if (o.skip) return { skip: o.skip };
  const review = [];
  const pk = p.packaging ?? null;
  const packSize = Number(p.pack_size ?? 1) || 1;
  const parts = p.count_parts ?? [];
  const variable = pk?.variable === true;

  // nome
  let name = o.name ?? p.name.replace(SUFFIX, '').replace(SIZE_IN_NAME, ' $1').replace(/\s+/g, ' ').trim();
  const renamed = name !== p.name && !o.name;

  const origin = o.origin ?? (isProducao(p) ? 'producao' : 'compra');

  // unidade de stock + recipiente
  let unit = o.unit ?? UNIT_MAP[p.unit] ?? null;
  let unitLabel = o.unit_label ?? null;
  let container = o.container === undefined ? undefined : o.container; // [name, qty] | null
  const spirits = ['Espirituosas', 'Licores'].includes(p.category ?? '');

  if (unit === null) {
    switch (p.unit) {
      case 'grf':
        if (spirits) {
          unit = 'cl';
          const cl = bottleCl(p) ?? 70;
          if (!bottleCl(p)) review.push('volume da garrafa assumido 70 cl');
          container ??= ['Garrafa', cl];
        } else {
          unit = 'un';
          unitLabel = 'garrafa';
        }
        break;
      case 'barril': {
        unit = 'L';
        const m = p.name.match(/(\d+)\s*L/i);
        container ??= ['Barril', m ? Number(m[1]) : 50];
        if (!m) review.push('capacidade do barril assumida 50 L');
        break;
      }
      case 'botija': unit = 'un'; unitLabel = 'botija'; break;
      case 'vasilha': unit = 'kg'; break;
      case 'embalagem':
        unit = 'un';
        unitLabel = pk?.units_per_inner > 1 ? 'saco' : 'embalagem';
        break;
      default:
        unit = 'un';
        review.push(`unidade V1 «${p.unit}» desconhecida`);
    }
  }
  if (unit === 'un' && !unitLabel) {
    if (/garrafa|grf/i.test(`${pk?.order_name ?? ''}`) || p.unit === 'grf') unitLabel = 'garrafa';
    else if (/nespresso|descafeinado/i.test(p.name)) unitLabel = 'cápsula';
    else if (/^chá/i.test(p.name)) unitLabel = 'saqueta';
    else if (/^rolos/i.test(p.name)) unitLabel = 'rolo';
    else if (/^copos/i.test(p.name)) unitLabel = 'copo';
  }

  // recipiente deduzido para unidades divisíveis (cl/g/L/kg/fatia) a partir de pack_size
  if (container === undefined) {
    if (unit === 'cl' && p.unit === 'cl' && packSize > 1) container = ['Garrafa', packSize];
    else if (unit === 'g' && packSize > 1) container = [cleanPackName(pk?.order_name) || 'Embalagem', packSize];
    else if (unit === 'L' && packSize > 1 && packSize <= 12 && pk) container = ['Pacote', 1]; // 6 × 1 L
    else if (unit === 'L' && packSize > 1) container = [cleanPackName(pk?.order_name) || 'Garrafão', packSize];
    else if (unit === 'fatia' && packSize > 1) container = ['Embalagem', packSize];
    else if (unit === 'kg' && !variable && packSize > 1 && pk) container = [cleanPackName(pk.order_name) || 'Embalagem', packSize];
    else container = null;
  }
  if (unit === 'un') container = null;

  // embalagem de compra
  let pack = o.pack; // [name, qty, nominal?]
  if (origin === 'producao') pack = null;
  else if (!pack) {
    let pname = cleanPackName(pk?.order_name) || null;
    if (!pname || pname === 'Unidade') pname = packSize > 1 ? (unit === 'un' ? 'Caixa' : 'Embalagem') : 'Unidade';
    if (!PACK_NAMES.includes(pname)) { review.push(`nome de embalagem «${pname}»`); }
    if (variable) pack = [pname, null, packSize > 1 ? packSize : null];
    else if (container) {
      const q = packSize / container[1];
      pack = [pname, Number.isInteger(q) && q >= 1 ? q : 1];
      if (!(Number.isInteger(q) && q >= 1) && packSize > 1) review.push(`pack_size ${packSize} vs recipiente ${container[1]}`);
    } else pack = [pname, packSize];
  }

  // preço: V1 price_net é por unidade de stock antiga
  const price = p.price_net == null ? null : Number(p.price_net);
  let packPrice = null;
  let priceNet = null;
  if (price != null) {
    const factor = unit !== (UNIT_MAP[p.unit] ?? p.unit) && p.unit === 'grf' && unit === 'cl' ? 1 / (container?.[1] ?? 70) : 1;
    const perUnit = price * factor;
    if (pack && pack[1] != null) packPrice = Math.round(perUnit * pack[1] * (container?.[1] ?? 1) * 10000) / 10000;
    else priceNet = perUnit;
  }

  // mínimo (na unidade de stock)
  let minLevel = p.min_level == null ? null : Number(p.min_level);
  if (minLevel != null && p.unit === 'grf' && unit === 'cl') minLevel = minLevel * (container?.[1] ?? 70);
  if (minLevel != null && p.unit === 'barril' && unit === 'L') minLevel = minLevel * (container?.[1] ?? 50);

  const locations = parts.some((x) => /^(Frios|Naturais|Armazém)$/.test(x)) ? [1, 2, 3] : null;
  const trackEmpties = o.track_empties ?? parts.some((x) => /vazios/i.test(x));

  let notes = (p.notes ?? '').replace(/vem da produção\s*·?\s*/i, '').replace(/^\s*·\s*|\s*·\s*$/g, '').trim() || null;
  if (renamed) notes = [notes, `nome V1: ${p.name}`].filter(Boolean).join(' · ');
  if (review.length) notes = [`REVER: ${review.join('; ')}`, notes].filter(Boolean).join(' · ');

  const aliases = Array.isArray(p.supplier_aliases) ? p.supplier_aliases.map(String) : null;

  return {
    legacy_id: p.id, name, area: p.area, category: p.category, supplier: p.supplier === 'Produção' ? null : p.supplier,
    supplier_aliases: aliases, origin, unit, unit_label: unit === 'un' ? unitLabel : null,
    container_name: container?.[0] ?? null, container_qty: container?.[1] ?? null,
    pack_name: pack?.[0] ?? null, pack_qty: pack?.[1] ?? null, pack_nominal_qty: pack?.[2] ?? null,
    pack_price_net: packPrice, price_net: priceNet, iva: p.iva == null ? null : Number(p.iva),
    min_level: minLevel, count_locations: locations, track_empties: trackEmpties, needs_recount: true,
    notes, active: p.active, review: review.length > 0,
  };
}

// ── Execução ──────────────────────────────────────────────────────────────
const moves = await sql`SELECT count(*) AS n FROM v2.stock_movements`;
if (Number(moves[0].n) > 0) {
  console.error('v2 já tem movimentos de stock; esta importação provisória não pode substituir o catálogo.');
  process.exit(1);
}
const v1 = await sql`SELECT * FROM products WHERE active ORDER BY area, category, name`;
const rows = [];
const skipped = [];
const seen = new Map();
for (const p of v1) {
  const d = derive(p);
  if (d.skip) { skipped.push(`${p.name}: ${d.skip}`); continue; }
  if (seen.has(d.name)) {
    d.notes = [`REVER: nome colide com «${seen.get(d.name)}»`, d.notes].filter(Boolean).join(' · ');
    d.name = p.name; d.review = true;
  }
  seen.set(d.name, p.name);
  rows.push(d);
}

const by = (f) => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
console.log(`V1 ativos: ${v1.length} · a importar: ${rows.length} · ignorados: ${skipped.length} · a rever: ${rows.filter((r) => r.review).length}`);
console.log('unidades:', JSON.stringify(by((r) => r.unit)));
console.log('recipientes:', JSON.stringify(by((r) => r.container_name ?? '(nenhum)')));
console.log('embalagens:', JSON.stringify(by((r) => r.pack_name ?? '(produção)')));
if (skipped.length) console.log('ignorados:', skipped.join(' | '));
console.log('\nA REVER:');
for (const r of rows.filter((r) => r.review)) console.log(` - ${r.name} [${r.unit}${r.container_name ? `, ${r.container_name} ${r.container_qty}` : ''}] ${r.notes}`);

if (!APPLY) { console.log('\n(dry run; usa --apply para escrever)'); process.exit(0); }

await sql.query('TRUNCATE v2.products RESTART IDENTITY CASCADE');
let n = 0;
for (const r of rows) {
  await sql`
    INSERT INTO v2.products (legacy_id, name, area, category, supplier, supplier_aliases, origin, unit, unit_label,
      container_name, container_qty, pack_name, pack_qty, pack_nominal_qty, pack_price_net, price_net, iva,
      min_level, count_locations, track_empties, needs_recount, notes, active)
    VALUES (${r.legacy_id}, ${r.name}, ${r.area}, ${r.category}, ${r.supplier}, ${r.supplier_aliases}, ${r.origin}, ${r.unit}, ${r.unit_label},
      ${r.container_name}, ${r.container_qty}, ${r.pack_name}, ${r.pack_qty}, ${r.pack_nominal_qty},
      ${r.pack_price_net}, ${r.price_net == null ? null : Math.round(r.price_net * 1e6) / 1e6}, ${r.iva},
      ${r.min_level}, ${r.count_locations}, ${r.track_empties}, ${r.needs_recount}, ${r.notes}, ${r.active})`;
  n++;
}
await sql.query('INSERT INTO v2.stock_levels (product_id, qty) SELECT id, 0 FROM v2.products ON CONFLICT DO NOTHING');
// preço por unidade derivado da embalagem (mesma regra do servidor)
await sql.query(`UPDATE v2.products SET price_net = round(pack_price_net / (pack_qty * COALESCE(container_qty, 1)), 6)
                 WHERE pack_price_net IS NOT NULL AND pack_qty IS NOT NULL`);
console.log(`\n${n} produtos escritos em v2.products`);
