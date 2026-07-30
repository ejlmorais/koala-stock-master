#!/usr/bin/env node
/**
 * Kitchen: converts products to consumption units (fatias/un) and seeds the
 * sale transformations from the Fichas Técnicas Cozinha PDF.
 *
 *   node scripts/seed-kitchen.mjs
 *
 * Unit model: the stock unit is what recipes consume (fatia, un, kg, porção);
 * pack_size converts ordered packs into stock units; count_parts with '*N'
 * multipliers let the team count closed packs + loose units
 * (e.g. "Embalagens*50,Fatias").
 *
 * Flagged assumptions (review in the editors):
 *  - Queijos fatiados: 1 kg embalagem = 50 fatias (~20 g/fatia); Chévre rulo
 *    180 g = 10 fatias. Fiambre = 50 fatias/kg.
 *  - Pão Tosta: 20 fatias por pacote. Pão Hamburguer: pacote = 1 (corrigir).
 *    Bolo do Caco: pacote = 1 (corrigir). Tortilhas: 12 por embalagem.
 *    Salsichas: 8 por frasco.
 *  - Doses estimadas: pasta de frango 100 g frango/tosta, pasta de atum 90 g
 *    atum/tosta, bifana 150 g, espinafre 0.06 embalagem, snacks 150 g,
 *    nachos 100 g (0.2 emb), prato tilápia 250 g.
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
const sql = neon(process.env.DATABASE_URL);

// name → { unit, pack, parts } (only what changes)
const PRODUCT_UPDATES = {
  'Queijo Flamengo': { unit: 'fatia', pack: 50, parts: ['Embalagens*50', 'Fatias'] },
  'Queijo Mozzarella': { unit: 'fatia', pack: 50, parts: ['Embalagens*50', 'Fatias'] },
  'Queijo Cheddar': { unit: 'fatia', pack: 50, parts: ['Embalagens*50', 'Fatias'] },
  'Queijo Emmental': { unit: 'fatia', pack: 50, parts: ['Embalagens*50', 'Fatias'] },
  'Queijo Chévre (180gr)': { unit: 'fatia', pack: 10, parts: ['Rulos*10', 'Fatias'] },
  Fiambre: { unit: 'fatia', pack: 50, parts: ['Embalagens*50', 'Fatias'] },
  'Pão Tosta (pacote)': { unit: 'fatia', pack: 20, parts: ['Pacotes*20', 'Fatias'] },
  'Pão Hamburguer (pacotes)': { unit: 'un', pack: 1, parts: null },
  'Pão HotDog (pacotes de 6)': { unit: 'un', pack: 6, parts: ['Pacotes*6', 'Unidades'] },
  'Pão Bifana (pacote de 10)': { unit: 'un', pack: 10, parts: ['Pacotes*10', 'Unidades'] },
  'Bolo do Caco (pacote)': { unit: 'un', pack: 1, parts: null },
  'Hamburguer (embalagem de 10)': { unit: 'un', pack: 10, parts: ['Embalagens*10', 'Unidades'] },
  'Prego (embalagem de 10)': { unit: 'un', pack: 10, parts: ['Embalagens*10', 'Unidades'] },
  'Croquetes de Carne (uni)': { unit: 'un', pack: 25, parts: ['Embalagens*25', 'Unidades'] },
  'Salsicha HotDog (frasco)': { unit: 'un', pack: 8, parts: ['Frascos*8', 'Unidades'] },
  'Tortilhas Tacos 12cm (embalagem)': { unit: 'un', pack: 12, parts: ['Embalagens*12', 'Unidades'] },
};

// zs_code: [[stock product name, qty per sale], ...]
const RECIPES = {
  1: [['Pão Tosta (pacote)', 2], ['Queijo Flamengo', 5], ['Fiambre', 2], ['Tomate Runner (uni)', 0.25]], // Tosta Mista
  6: [['Pão Tosta (pacote)', 2], ['Queijo Mozzarella', 6], ['Pesto', 0.05], ['Tomate Runner (uni)', 0.25]], // Mamma Mia
  138: [['Pão Tosta (pacote)', 2], ['Queijo Flamengo', 1], ['Frango Desfiado (kg)', 0.1]], // Pollo Hermano
  17: [['Pão Tosta (pacote)', 2], ['Atum 785g', 0.09], ['Ovo Cozido', 1]], // Tuna Turner
  35: [['Pão Tosta (pacote)', 2], ['Queijo Flamengo', 3], ['Queijo Chévre (180gr)', 1], ['Queijo Emmental', 3]], // Honey & Cheese
  28: [['Bolo do Caco (pacote)', 1], ['Prego (embalagem de 10)', 1]], // Prego
  53: [['Pão Hamburguer (pacotes)', 1], ['Hamburguer (embalagem de 10)', 1], ['Queijo Cheddar', 2], ['Tomate Runner (uni)', 0.25]], // Hamburguer
  140: [['Pão Hamburguer (pacotes)', 1], ['Hamburguer veg (un)', 1], ['Queijo Flamengo', 2], ['Tomate Runner (uni)', 0.25]], // H. Vegetariano
  141: [['Bolo do Caco (pacote)', 1], ['Hamburguer Alheira (un)', 1], ['Ovos L (uni.)', 1], ['Queijo Flamengo', 1], ['Espinafre (embalagem)', 0.06]], // H. de Alheira
  139: [['Pão HotDog (pacotes de 6)', 1], ['Salsicha HotDog (frasco)', 1]], // Kids Hot Dog
  136: [['Pão Bifana (pacote de 10)', 1], ['Bifana (kg)', 0.15]], // Bifana
  149: [['Batata Frita Crispers (2.5kg)', 0.235]], // Batatas Fritas
  153: [['Chouriço (porção)', 1], ['Pão Tosta (pacote)', 1.5]], // Chouriço Assado
  154: [['Moelas (porções cozinhadas)', 1], ['Pão Tosta (pacote)', 2]], // Moelas
  48: [['Pica Pau (porção)', 1], ['Pão Tosta (pacote)', 2]], // Pica Pau
  150: [['Abacate (kg)', 0.1], ['Nachos (500gr)', 0.2]], // Guacamole
  151: [['Grão de Bico Frasco (540gr)', 0.1]], // Humus
  300: [['Croquetes de Carne (uni)', 1]], // Croquete Carne
  304: [['Croquetes de Carne (uni)', 3]], // Trio de Croquetes
  301: [['Bolinhas de Alheira (porções)', 1]], // Bolinha de Alheira
  305: [['Bolinhas de Alheira (porções)', 3]], // Trio de Bolinhas
  302: [['Taco Tilápia (porções)', 1], ['Tortilhas Tacos 12cm (embalagem)', 2], ['Abacate (kg)', 0.04]], // Tacos de Tilápia
  241: [['Porção Taco de Rabo de Boi', 1], ['Tortilhas Tacos 12cm (embalagem)', 2]], // Tacos de Rabo de Boi
  190: [['Frango Desfiado (kg)', 0.1]], // Salada da Chef
  137: [['Pão Tosta (pacote)', 2]], // Torrada
  188: [['Pão Tosta (pacote)', 1]], // Torrada 1/2
  100018: [['Pão Tosta (pacote)', 2]], // Cesto de Pão
  256: [['Maminha(porção)', 1]], // Prato Maminha
  269: [['Filete Tilápia (750gr)', 0.25]], // Prato Tilápia
  142: [['Tremoços (balde)', 0.15]], // Tremoços
  143: [['Amendoim Frito c/ Sal (1kg)', 0.15]], // Amendoins
  144: [['Azeitona Mista Natural (balde)', 0.15]], // Azeitonas
  // Extras
  278: [['Queijo Flamengo', 2]],
  100007: [['Queijo Flamengo', 2]],
  100005: [['Ovos L (uni.)', 1]],
  100001: [['Tomate Runner (uni)', 0.25]],
  100003: [['Cebola (kg)', 0.05]],
  100004: [['Bacon Fatiado (embalagem)', 0.15]],
  299: [['Pão Tosta (pacote)', 2]],
  11: [['Hamburguer (embalagem de 10)', 1]], // Carne Hamburguer extra
  279: [['Nachos (500gr)', 0.2]],
  100041: [['Nachos (500gr)', 0.2]],
};

const rows = await sql`SELECT id, name FROM products WHERE active`;
const idByName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));

let updated = 0;
for (const [name, u] of Object.entries(PRODUCT_UPDATES)) {
  const id = idByName.get(name.toLowerCase());
  if (!id) {
    console.log(`aviso: produto "${name}" não encontrado`);
    continue;
  }
  await sql`
    UPDATE products SET unit = ${u.unit}, pack_size = ${u.pack}, count_parts = ${u.parts}
    WHERE id = ${id}`;
  updated++;
}

let saved = 0;
const missing = [];
for (const [code, comps] of Object.entries(RECIPES)) {
  const resolved = [];
  for (const [name, qty] of comps) {
    const id = idByName.get(name.toLowerCase());
    if (!id) {
      missing.push(`${code}: componente "${name}" não encontrado`);
      continue;
    }
    resolved.push([id, qty]);
  }
  if (resolved.length === 0) continue;
  await sql`DELETE FROM sale_components WHERE zs_code = ${code}`;
  for (const [productId, qty] of resolved) {
    await sql`
      INSERT INTO sale_components (zs_code, product_id, qty_per_sale)
      VALUES (${code}, ${productId}, ${qty})`;
  }
  saved++;
}

console.log(`Produtos atualizados: ${updated}. Transformações de cozinha: ${saved}.`);
if (missing.length) console.log('Avisos:\n  ' + missing.join('\n  '));
