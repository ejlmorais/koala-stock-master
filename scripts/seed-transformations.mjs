#!/usr/bin/env node
/**
 * Seeds sale_components (transformations) for bar drinks, converted from the
 * koala-bar Fichas Técnicas + the Zonesoft sale catalog.
 *
 *   node scripts/seed-transformations.mjs
 *
 * Idempotent: replaces each listed sale product's components. Quantities are
 * in the STOCK unit (bottles, barris, caixas, kg) consumed per sale.
 *
 * Assumptions to review in the Transformações editor:
 *  - Spirits without a size in the name are 70cl bottles; Macieira, Martini,
 *    Groselha, Rum, Vodka and Cachaça are 1L (5cl pour → 0.05; 5cl of 70cl
 *    → 0.0714).
 *  - Café Nespresso/Descafeinado "caixa" = 100 cápsulas (1 café → 0.01).
 *  - Leite (Bar) unit = 1L (Galão 200ml → 0.2).
 *  - Imperial 0.2L / Caneca 0.5L / Tulipa 0.33L of the 50L Heineken barril;
 *    Bandida do Pomar copo 0.25L of the 20L barril.
 *  - Régua Heineken = 5 imperiais; Régua Caneca = 5 canecas.
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

// 5cl pours
const P70 = 0.0714; // 5cl of a 70cl bottle
const P100 = 0.05; // 5cl of a 1L bottle

// zs_code: [[stock product name, qty per sale], ...]
const RECIPES = {
  // ---- Cocktails ----
  102: [['Aperol', P70], ['Espumante Valmarone Bruto', 0.133]], // Aperol Spritz (~10cl espumante)
  101: [['Cachaça 51', P100]], // Caipirinha
  100: [['Rum', P100], ['Água Castello', 1]], // Mojito
  104: [['Vodka Eristoff', P100], ['Ginger Beer', 1]], // Moscow Mule
  105: [['Gin Bombay', 0.0429], ['Campari', 0.0429], ['Martini Rosso 1L', 0.03]], // Negroni 3+3+3cl
  298: [['Rum', P100], ['Groselha 1L', 0.05], ['Baileys', 0.0429]], // Sakura
  297: [['Kombucha Folha de Figueira', 0.5]], // Fig Garden (meia lata)
  295: [['Kombucha Hortelã-Pimenta', 0.5]], // Garden Cooler
  296: [['Kombucha Gengibre', 0.5]], // Ginger Fizz
  // ---- Gin & Tonic: 5cl gin + 1 tónica 25cl ----
  79: [['Gin Bombay', P70], ['Água Tónica Royal Bliss 25cl', 1]],
  80: [['Gin Beefeater', P70], ['Água Tónica Royal Bliss 25cl', 1]],
  81: [['Gin Tanqueray', P70], ['Água Tónica Royal Bliss 25cl', 1]],
  82: [['Gin Hendricks', P70], ['Água Tónica Royal Bliss 25cl', 1]],
  83: [['Gin Nordés', P70], ['Água Tónica Royal Bliss 25cl', 1]],
  84: [['Gin Black Pig', P70], ['Água Tónica Royal Bliss 25cl', 1]],
  // ---- Sangrias & vinho ----
  98: [['Macieira 1L', P100], ['Licor Beirão', P70], ['Vinho Tinto', 1], ['Gasosa Spaty 1.5L', 0.2]], // Sangria Tinta
  97: [['Gin Bombay', P70], ['Licor Beirão', P70], ['Vinho Branco', 1], ['Gasosa Spaty 1.5L', 0.2]], // Sangria Branca
  99: [['Espumante Valmarone Bruto', 1], ['Ginja', P70]], // Sangria Espumante (frutos vermelhos)
  100008: [['Bandida de Verano', 1]], // Tinto de Verano
  100009: [['Vinho Tinto', 0.2]], // Copo Vinho Tinto (15cl of 75cl)
  100010: [['Vinho Branco', 0.2]], // Copo Vinho Branco
  288: [['Vinho Branco', 1]], // Garrafa Vinho Branco
  // ---- Cafetaria (caixa = 100 cápsulas; leite 1L) ----
  121: [['Café Nespresso (caixa)', 0.01]], // Café
  124: [['Café Nespresso (caixa)', 0.01]], // Abatanado
  123: [['Café Nespresso (caixa)', 0.02]], // Café Duplo
  100026: [['Café Nespresso (caixa)', 0.01]], // Carioca Café
  122: [['Descafeinado (caixa)', 0.01]], // Descafeinado
  186: [['Descafeinado (caixa)', 0.01]], // Abatanado Descafeinado
  100028: [['Descafeinado (caixa)', 0.02]], // Descafeinado Duplo
  131: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.1]], // Cappuccino
  132: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.1]], // Mocha
  130: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.15]], // Latte Macchiato
  129: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.02]], // Espresso Macchiato
  125: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.2]], // Galão
  100029: [['Descafeinado (caixa)', 0.01], ['Leite (Bar)', 0.2]], // Galão Descafeinado
  126: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.12]], // Meia de Leite
  100032: [['Descafeinado (caixa)', 0.01], ['Leite (Bar)', 0.12]], // Meia de Leite Desc.
  100030: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.03]], // Garoto
  187: [['Leite (Bar)', 0.2]], // Copo de Leite
  173: [['Café Nespresso (caixa)', 0.01], ['Leite (Bar)', 0.1]], // Iced Cappuccino
  174: [['Café Nespresso (caixa)', 0.01]], // Iced Coffee
  100031: [['Café Nespresso (caixa)', 0.01]], // Mazagran
  // ---- Cerveja de pressão (Heineken barril 50L / Bandida barril 20L) ----
  106: [['Heineken Barril 50L', 0.004]], // Imperial 0.2L
  107: [['Heineken Barril 50L', 0.01]], // Caneca 0.5L
  189: [['Heineken Barril 50L', 0.0066]], // Tulipa 0.33L
  221: [['Heineken Barril 50L', 0.02]], // Régua Heineken (5 imperiais)
  242: [['Heineken Barril 50L', 0.05]], // Régua Caneca (5 canecas)
  108: [['Bandida do Pomar Barril 20L', 0.0125]], // Bandida do Pomar 0.25L
  // ---- Garrafas & águas com nomes diferentes do stock ----
  113: [['Sagres Preta 33cl', 1]], // Sagres Preta
  100020: [['Sagres Preta 0.0% 33cl', 1]], // Sagres Preta 0.0%
  245: [['Trindade Fenix', 1]],
  284: [['Corona', 1]], // Coronita
  285: [['Corona', 6]], // Balde 6 Coronitas
  100068: [['Heineken 25cl', 6]], // Promo 6 Heineken
  55: [['Água Luso 50cl PET', 1]], // Água
  56: [['Pedras Salgadas', 1]], // Água das Pedras
  57: [['Pedras Salgadas Limão', 1]],
  58: [['Pedras Salgadas Maracujá', 1]],
  220: [['Pedras Salgadas Tangerina', 1]],
  78: [['Água Tónica Royal Bliss 25cl', 1]], // Água Tónica
  65: [['Kombucha Hortelã-Pimenta', 1]], // sale name has no hyphen
  100033: [['Groselha 1L', 0.05]], // Groselha (sumo)
};

const nameRows = await sql`SELECT id, name FROM products WHERE active`;
const idByName = new Map(nameRows.map((r) => [r.name.toLowerCase(), r.id]));
const zsRows = await sql`SELECT code, name FROM zs_products`;
const zsNames = new Map(zsRows.map((r) => [r.code, r.name]));

let saved = 0;
const missing = [];
for (const [code, comps] of Object.entries(RECIPES)) {
  const resolved = [];
  for (const [name, qty] of comps) {
    const id = idByName.get(name.toLowerCase());
    if (!id) {
      missing.push(`${zsNames.get(code) ?? code}: componente "${name}" não encontrado`);
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

console.log(`Transformações guardadas: ${saved}`);
if (missing.length) console.log('Avisos:\n  ' + missing.join('\n  '));
