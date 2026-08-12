#!/usr/bin/env node
/**
 * Syncs an edited produtos.csv back into the database.
 *
 *   node scripts/sync-products.mjs exports/produtos.csv         # dry run (diff)
 *   node scripts/sync-products.mjs exports/produtos.csv --apply # write changes
 *
 * Matches rows by `id`. Rows with empty id are created. Products in the DB
 * but absent from the file are only reported — never deleted (use ativo=não
 * to deactivate). Informational columns (stock/valor) are ignored.
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
  } catch {}
}

const APPLY = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Uso: node scripts/sync-products.mjs <ficheiro.csv> [--apply]');
  process.exit(1);
}

/** Semicolon-separated CSV with quoted fields (as produced by the export). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ';') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  return rows;
}

const numOrNull = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const [header, ...lines] = parseCsv(readFileSync(file, 'utf8'));
const col = (name) => {
  const i = header.findIndex((h) => h.trim().toLowerCase().startsWith(name));
  if (i === -1) throw new Error(`coluna "${name}" não encontrada no ficheiro`);
  return i;
};
const C = {
  id: col('id'), ativo: col('ativo'), nome: col('nome'), area: col('area'),
  categoria: col('categoria'), unidade: col('unidade'), un_pack: col('un_pack'),
  fornecedores: col('fornecedores'), preco: col('preco_siva'), iva: col('iva'),
  ponto: col('ponto_encomenda'), campos: col('campos_contagem'),
  zonesoft: col('zonesoft'), por_venda: col('por_venda'), notas: col('notas'),
};

function rowToProduct(r) {
  return {
    id: String(r[C.id] ?? '').trim() ? Number(r[C.id]) : null,
    active: String(r[C.ativo]).trim().toLowerCase() !== 'não' &&
      String(r[C.ativo]).trim().toLowerCase() !== 'nao',
    name: String(r[C.nome] ?? '').trim(),
    area: String(r[C.area] ?? '').trim().toLowerCase() === 'cozinha' ? 'kitchen' : 'bar',
    category: String(r[C.categoria] ?? '').trim() || null,
    unit: String(r[C.unidade] ?? '').trim() || 'un',
    pack_size: numOrNull(r[C.un_pack]) ?? 1,
    supplier: String(r[C.fornecedores] ?? '').trim() || null,
    price_net: numOrNull(r[C.preco]),
    iva: numOrNull(r[C.iva]),
    min_level: numOrNull(r[C.ponto]),
    count_parts: String(r[C.campos] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    zonesoft_name: String(r[C.zonesoft] ?? '').trim() || null,
    units_per_sale: numOrNull(r[C.por_venda]) ?? 1,
    notes: String(r[C.notas] ?? '').trim() || null,
  };
}

const sql = neon(process.env.DATABASE_URL);
const dbRows = await sql`SELECT * FROM products ORDER BY id`;
const dbById = new Map(dbRows.map((p) => [p.id, p]));

const FIELDS = [
  ['active', (p) => p.active],
  ['name', (p) => p.name],
  ['area', (p) => p.area],
  ['category', (p) => p.category],
  ['unit', (p) => p.unit],
  ['pack_size', (p) => Number(p.pack_size)],
  ['supplier', (p) => p.supplier],
  ['price_net', (p) => (p.price_net === null ? null : Number(p.price_net))],
  ['iva', (p) => (p.iva === null ? null : Number(p.iva))],
  ['min_level', (p) => (p.min_level === null ? null : Number(p.min_level))],
  ['count_parts', (p) => (p.count_parts ?? []).join(',')],
  ['zonesoft_name', (p) => p.zonesoft_name],
  ['units_per_sale', (p) => Number(p.units_per_sale)],
  ['notes', (p) => p.notes],
];

const updates = [];
const creates = [];
const seen = new Set();
for (const line of lines) {
  const next = rowToProduct(line);
  if (!next.name) continue;
  if (next.id === null) {
    creates.push(next);
    continue;
  }
  seen.add(next.id);
  const current = dbById.get(next.id);
  if (!current) {
    console.log(`⚠️  id ${next.id} («${next.name}») não existe na base de dados — ignorado`);
    continue;
  }
  const changed = FIELDS.filter(([, get]) => {
    const a = get(current);
    const b = get(next);
    return (a ?? null) !== (b ?? null) && String(a ?? '') !== String(b ?? '');
  });
  if (changed.length > 0) {
    updates.push({ id: next.id, name: next.name, next, changed });
  }
}
const missing = dbRows.filter((p) => !seen.has(p.id));

console.log(`\nAlterações: ${updates.length} · Novos: ${creates.length} · No BD mas fora do ficheiro: ${missing.length}\n`);
for (const u of updates) {
  const parts = u.changed.map(([f, get]) => `${f}: «${get(dbById.get(u.id)) ?? '—'}» → «${get(u.next) ?? '—'}»`);
  console.log(`  ~ [${u.id}] ${u.name}: ${parts.join(' · ')}`);
}
for (const c of creates) console.log(`  + NOVO: ${c.name} (${c.area}/${c.category ?? '—'})`);
if (missing.length) {
  console.log(`  (fora do ficheiro, mantidos: ${missing.slice(0, 10).map((p) => p.name).join(', ')}${missing.length > 10 ? '…' : ''})`);
}

if (!APPLY) {
  console.log('\nDry run — nada foi alterado. Repetir com --apply para gravar.');
  process.exit(0);
}

for (const u of updates) {
  const p = u.next;
  await sql`
    UPDATE products SET
      active = ${p.active}, name = ${p.name}, area = ${p.area},
      category = ${p.category}, unit = ${p.unit}, pack_size = ${p.pack_size},
      supplier = ${p.supplier}, price_net = ${p.price_net}, iva = ${p.iva},
      min_level = ${p.min_level},
      count_parts = ${p.count_parts.length ? p.count_parts : null},
      zonesoft_name = ${p.zonesoft_name}, units_per_sale = ${p.units_per_sale},
      notes = ${p.notes}
    WHERE id = ${u.id}`;
}
for (const p of creates) {
  await sql`
    INSERT INTO products (active, name, area, category, unit, pack_size, supplier,
                          price_net, iva, min_level, count_parts, zonesoft_name,
                          units_per_sale, notes)
    VALUES (${p.active}, ${p.name}, ${p.area}, ${p.category}, ${p.unit},
            ${p.pack_size}, ${p.supplier}, ${p.price_net}, ${p.iva}, ${p.min_level},
            ${p.count_parts.length ? p.count_parts : null}, ${p.zonesoft_name},
            ${p.units_per_sale}, ${p.notes})
    ON CONFLICT (name) DO NOTHING`;
}
console.log(`\nAplicado: ${updates.length} atualizados, ${creates.length} criados. ✅`);
