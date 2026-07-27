#!/usr/bin/env node
/**
 * Imports the stock spreadsheets (scripts/stock-import.json) into products.
 *
 *   node scripts/import-stock.mjs
 *
 * Idempotent: re-running updates catalog metadata (category, supplier, price,
 * IVA, min level, count parts) but never touches zonesoft_name/units_per_sale
 * and only applies the spreadsheet quantity as the initial count for products
 * that have no counts or stock yet.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
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
  } catch {
    // file not present — fine
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const sql = neon(url);

const items = JSON.parse(readFileSync(join(root, 'scripts', 'stock-import.json'), 'utf8'));
let created = 0;
let updated = 0;
let counted = 0;

for (const item of items) {
  const minLevel = item.min_level != null && item.min_level >= 0 ? item.min_level : null;
  const rows = await sql`
    INSERT INTO products (name, unit, area, category, supplier, price_net, iva,
                          min_level, notes, count_parts)
    VALUES (${item.name}, ${item.unit ?? 'un'}, ${item.area}, ${item.category},
            ${item.supplier}, ${item.price_net}, ${item.iva}, ${minLevel},
            ${item.notes}, ${item.count_parts})
    ON CONFLICT (name) DO UPDATE
    SET unit = EXCLUDED.unit, area = EXCLUDED.area, category = EXCLUDED.category,
        supplier = EXCLUDED.supplier, price_net = EXCLUDED.price_net,
        iva = EXCLUDED.iva, min_level = EXCLUDED.min_level,
        notes = EXCLUDED.notes, count_parts = EXCLUDED.count_parts
    RETURNING id, (xmax = 0) AS inserted`;
  const { id, inserted } = rows[0];
  if (inserted) created++;
  else updated++;

  const existing = await sql`
    SELECT (SELECT COUNT(*) FROM stock_counts WHERE product_id = ${id}) AS counts,
           (SELECT COUNT(*) FROM stock_levels WHERE product_id = ${id}) AS levels`;
  if (Number(existing[0].counts) > 0 || Number(existing[0].levels) > 0) continue;

  const qty = item.qty ?? 0;
  await sql`
    INSERT INTO stock_counts (product_id, qty, previous_qty, note, counted_by)
    VALUES (${id}, ${qty}, 0, 'Importação da folha de cálculo', 'importação')`;
  if (qty !== 0) {
    await sql`
      INSERT INTO stock_levels (product_id, area, qty) VALUES (${id}, ${item.area}, ${qty})
      ON CONFLICT (product_id, area) DO UPDATE SET qty = ${qty}, updated_at = now()`;
    await sql`
      INSERT INTO stock_movements (product_id, area, delta, reason, ref_type, note, created_by)
      VALUES (${id}, ${item.area}, ${qty}, 'adjustment', 'count',
              'Importação da folha de cálculo', 'importação')`;
  }
  counted++;
}

console.log(`Products: ${created} created, ${updated} updated. Initial counts applied: ${counted}.`);
