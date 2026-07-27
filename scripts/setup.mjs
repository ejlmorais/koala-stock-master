#!/usr/bin/env node
/**
 * One-time database setup: creates all koala-stock tables.
 *
 *   npm run db:setup
 *
 * Reads DATABASE_URL from the environment or from .env.local / .env.
 * Idempotent: safe to run again after pulling schema changes.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

function loadDotEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !(match[1] in process.env)) {
          process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      // file not present — fine
    }
  }
}

loadDotEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env.local or the environment.');
  process.exit(1);
}

const sql = neon(url);

console.log('Creating tables…');

await sql`
  CREATE TABLE IF NOT EXISTS products (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    unit text NOT NULL DEFAULT 'un',
    area text NOT NULL DEFAULT 'bar' CHECK (area IN ('bar', 'kitchen')),
    zonesoft_name text,
    units_per_sale numeric(12,3) NOT NULL DEFAULT 1,
    min_level numeric(12,3),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS products_zonesoft_name_key
  ON products (lower(zonesoft_name)) WHERE zonesoft_name IS NOT NULL`;

await sql`
  CREATE TABLE IF NOT EXISTS stock_levels (
    product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    area text NOT NULL CHECK (area IN ('bar', 'kitchen')),
    qty numeric(12,3) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, area)
  )`;

await sql`
  CREATE TABLE IF NOT EXISTS stock_movements (
    id serial PRIMARY KEY,
    product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    area text NOT NULL CHECK (area IN ('bar', 'kitchen')),
    delta numeric(12,3) NOT NULL,
    reason text NOT NULL CHECK (reason IN ('manual', 'sale', 'order', 'adjustment')),
    ref_type text,
    ref_id text,
    note text,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE INDEX IF NOT EXISTS stock_movements_product_idx
  ON stock_movements (product_id, created_at DESC)`;

await sql`
  CREATE INDEX IF NOT EXISTS stock_movements_ref_idx
  ON stock_movements (reason, ref_type, ref_id)`;

await sql`
  CREATE TABLE IF NOT EXISTS sales_days (
    sale_date date PRIMARY KEY,
    gross_total numeric(14,2) NOT NULL DEFAULT 0,
    items_count integer NOT NULL DEFAULT 0,
    raw jsonb,
    synced_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE TABLE IF NOT EXISTS sale_items (
    id serial PRIMARY KEY,
    sale_date date NOT NULL REFERENCES sales_days(sale_date) ON DELETE CASCADE,
    product_name text NOT NULL,
    zs_code text,
    qty numeric(12,3) NOT NULL,
    gross numeric(14,2) NOT NULL DEFAULT 0,
    product_id integer REFERENCES products(id) ON DELETE SET NULL,
    UNIQUE (sale_date, product_name)
  )`;

await sql`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS zs_code text`;

await sql`
  CREATE TABLE IF NOT EXISTS zs_products (
    code text PRIMARY KEY,
    name text NOT NULL,
    familia_code integer,
    familia_name text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;

// Catalog metadata mirrored from the stock spreadsheets.
await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS category text`;
await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier text`;
await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_net numeric(12,4)`;
await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS iva numeric(5,2)`;
await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS notes text`;
// Sub-count labels for the counting page (e.g. {Frios,Naturais,Armazém}).
// A label prefixed with '!' is recorded but NOT added to the stock total
// (e.g. !Vazios — empty kegs worth tracking for reorders).
await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS count_parts text[]`;

// Every submitted count, kept forever (the ledger stores the delta; this
// stores what was actually typed, including the per-part breakdown).
await sql`
  CREATE TABLE IF NOT EXISTS stock_counts (
    id serial PRIMARY KEY,
    product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    qty numeric(12,3) NOT NULL,
    parts jsonb,
    previous_qty numeric(12,3),
    note text,
    counted_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE INDEX IF NOT EXISTS stock_counts_product_idx
  ON stock_counts (product_id, created_at DESC)`;

// Transformations: one Zonesoft sale product consumes N stock products
// (e.g. Tosta Mista → pão + queijo + fiambre). When a sale item's code has
// rows here, these drive the stock decrement instead of zonesoft_name.
await sql`
  CREATE TABLE IF NOT EXISTS sale_components (
    id serial PRIMARY KEY,
    zs_code text NOT NULL,
    product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    qty_per_sale numeric(12,4) NOT NULL,
    UNIQUE (zs_code, product_id)
  )`;

await sql`
  CREATE INDEX IF NOT EXISTS sale_items_name_date_idx
  ON sale_items (product_name, sale_date)`;

await sql`
  CREATE TABLE IF NOT EXISTS orders (
    id serial PRIMARY KEY,
    supplier text NOT NULL,
    status text NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
    ordered_at timestamptz,
    received_at timestamptz,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

await sql`
  CREATE TABLE IF NOT EXISTS order_items (
    id serial PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id integer NOT NULL REFERENCES products(id),
    qty numeric(12,3) NOT NULL,
    unit_cost numeric(12,4),
    area text CHECK (area IS NULL OR area IN ('bar', 'kitchen'))
  )`;

console.log('Done. Tables: products, stock_levels, stock_movements, sales_days, sale_items, orders, order_items');
