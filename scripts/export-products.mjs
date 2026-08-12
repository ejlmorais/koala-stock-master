#!/usr/bin/env node
/**
 * Exports the full product catalog to exports/produtos.csv (semicolon CSV,
 * UTF-8 BOM — opens directly in Excel/Google Sheets with accents intact).
 *
 *   node scripts/export-products.mjs
 *
 * Editable columns are synced back by scripts/sync-products.mjs; the last
 * columns (stock atual, valor) are informational only and ignored on sync.
 * The `id` column is the key — never change it; leave it empty on new rows.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}

const sql = neon(process.env.DATABASE_URL);

export const HEADERS = [
  'id', 'ativo', 'nome', 'area', 'categoria', 'unidade', 'un_pack',
  'fornecedores', 'preco_siva', 'preco_pack', 'iva', 'ponto_encomenda', 'campos_contagem',
  'zonesoft', 'por_venda', 'notas', 'stock_atual (info)', 'valor_stock (info)',
];

const rows = await sql`
  SELECT p.*, COALESCE(SUM(l.qty), 0) AS total_qty
  FROM products p
  LEFT JOIN stock_levels l ON l.product_id = p.id
  GROUP BY p.id
  ORDER BY p.area, p.category NULLS LAST, p.name`;

const num = (v) => (v === null || v === undefined ? '' : String(Number(v)));
const table = rows.map((p) => [
  String(p.id),
  p.active ? 'sim' : 'não',
  p.name,
  p.area === 'kitchen' ? 'cozinha' : 'bar',
  p.category ?? '',
  p.unit,
  num(p.pack_size),
  p.supplier ?? '',
  num(p.price_net),
  p.price_net !== null ? String(Math.round(Number(p.price_net) * Number(p.pack_size) * 10000) / 10000) : '',
  num(p.iva),
  num(p.min_level),
  (p.count_parts ?? []).join(','),
  p.zonesoft_name ?? '',
  num(p.units_per_sale),
  p.notes ?? '',
  num(p.total_qty),
  p.price_net !== null ? (Number(p.total_qty) * Number(p.price_net)).toFixed(2) : '',
]);

const quote = (v) => `"${String(v).replaceAll('"', '""')}"`;
const csv =
  '﻿' +
  [HEADERS, ...table].map((row) => row.map(quote).join(';')).join('\r\n');

mkdirSync(join(root, 'exports'), { recursive: true });
const out = join(root, 'exports', 'produtos.csv');
writeFileSync(out, csv);
console.log(`${table.length} produtos → ${out}`);
