#!/usr/bin/env node
/**
 * Aplica a folha «Unidades & Embalagens — Produtos Koala» (set. 2026):
 * packaging nomeado, pack_size, campos de contagem, preços (gelados/chás)
 * e volumes das garrafas nas notas. Decisões do Emanuel:
 *  - bebidas mantêm contagem por 3 locais; barris mantêm Engatados/Selados;
 *  - 1 garrafa = 1 unidade de stock (volume em notes p/ receitas em cl);
 *  - preços indicados são s/IVA por caixa (dividimos pelo nº de unidades);
 *  - «peso a inserir» → packaging.variable = true (receção pede a qty).
 * Idempotente: correr duas vezes dá no mesmo.
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  try {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
const sql = neon(process.env.DATABASE_URL);

const LOCAIS = ['Frios', 'Naturais', 'Armazém'];
const KEG = ['Engatados', '!Vazios', 'Selados'];
const pkg = (order, n, inner = null, perOrder = 1, extra = {}) => ({
  order_name: order,
  inner_name: inner,
  inner_per_order: perOrder,
  units_per_inner: n,
  ...extra,
});

// [nome, {unit?, pack?, packaging?, parts? (null limpa), price?, iva?, notes?}]
const U = [];
const drink = (name, order, n, price) =>
  U.push([name, { pack: n, packaging: pkg(order, n), parts: LOCAIS, ...(price ? { price } : {}) }]);
const gelado = (name, n, boxPrice) =>
  U.push([name, { pack: n, packaging: pkg('Caixa', n), price: +(boxPrice / n).toFixed(4), iva: 23 }]);
const cha = (name, n, boxPrice) =>
  U.push([name, { pack: n, packaging: pkg('Caixa', n), ...(boxPrice ? { price: +(boxPrice / n).toFixed(4) } : {}) }]);
const garrafa = (name, vol) => U.push([name, { pack: 1, packaging: pkg('Garrafa', 1), notes: vol }]);
const emb = (name, order, n, extra = {}) => U.push([name, { pack: n, packaging: pkg(order, n), ...extra }]);
const varPeso = (name, order = 'Embalagem') =>
  U.push([name, { packaging: pkg(order, 1, null, 1, { variable: true }) }]);
const producao = (name) => U.push([name, { notes: 'vem da produção' }]);

// Cafetaria
emb('Biscoito Biscoff', 'Caixa', 300, { packaging: pkg('Caixa', 50, 'Embalagem', 6), parts: ['Embalagens*50'] });
emb('Café Nespresso (caixa)', 'Caixa', 50, { parts: ['Embalagens*50'] });
for (const t of ['Camomila', 'Cidreira', 'Frutos Vermelhos', 'Maçã e Canela', 'Preto', 'Verde']) cha(`Chá ${t}`, 20, t === 'Maçã e Canela' ? 2.63 : null);
for (const t of ['Lucia Lima', 'Menta', 'Tília']) cha(`Chá ${t}`, 10, null);
emb('Copos Café Descartáveis', 'Caixa', 50);
U.push(['Descafeinado (caixa)', { unit: 'un', pack: 50, packaging: pkg('Caixa', 50), price: +(18.23 / 50).toFixed(4), convertLevels: 50 }]);
emb('Leite (Bar)', 'Embalagem', 6);
emb('Paletinas', 'Embalagem', 100);
// Cervejas garrafa / sumos / águas / vinhos
drink('Bandida de Verano', 'Embalagem', 24);
drink('Corona', 'Caixa', 24);
drink('Franziskaner', 'Caixa', 20);
drink('Guinness', 'Embalagem', 24);
drink('Heineken 0.0%', 'Embalagem', 24);
drink('Heineken 25cl', 'Embalagem', 24);
drink('Praxis Dunkel', 'Embalagem', 12);
drink('Praxis IPA', 'Embalagem', 12);
drink('Sagres 33cl', 'Grade', 24);
drink('Sagres Bohemia', 'Grade', 24);
drink('Sagres Preta 33cl', 'Grade', 24);
drink('Trindade Fenix', 'Grade', 24);
U.push(['Bandida do Pomar Barril 20L', { pack: 1, packaging: pkg('Barril', 1), parts: KEG }]);
U.push(['Heineken Barril 50L', { pack: 1, packaging: pkg('Barril', 1), parts: KEG }]);
U.push(['Gás Dióxido Carbono 10kg', { unit: 'botija', pack: 1, packaging: pkg('Botija', 1), parts: null }]);
for (const [n, vol] of [
  ['Amêndoa Amarga', '70cl'], ['Aperol', '70cl'], ['Baileys', '70cl'], ['Black Label', '70cl'],
  ['CRF', '70cl'], ['Cachaça 51', '70cl'], ['Campari', '70cl'], ['Gin Beefeater', '70cl'],
  ['Gin Black Pig', '50cl'], ['Gin Bombay', '70cl'], ['Gin Hendricks', '70cl'], ['Gin Nordés', '70cl'],
  ['Gin Tanqueray', '70cl'], ['Ginja', '100cl'], ['Groselha 1L', '100cl'], ['Jameson', '70cl'],
  ['Licor Beirão', '70cl'], ['Licor de Café', '70cl'], ['Macieira 1L', '100cl'], ['Martini Rosso 1L', '100cl'],
  ['Moscatel', '70cl'], ['Red Label', '70cl'], ['Rum', '70cl'], ['Tequilla Don Diego', '70cl'],
  ['Triple Seco', '70cl'], ['Vinho do Porto Velhotes 10 Anos', '70cl'], ['Vodka Eristoff', '70cl'],
]) garrafa(n, vol);
gelado('Calippo Limão', 24, 23.52); gelado('Calippo Morango', 24, 23.52);
gelado('Cone Perna Pau', 24, 29.76); gelado('Cornetto Clássico', 24, 29.76);
gelado('Cornetto Morango', 24, 29.76); gelado('Cornetto Tropical', 24, 29.76);
gelado('Fizz Limão', 30, 19.5); gelado('Magnum Amêndoa', 20, 32.6);
gelado('Magnum Branco', 20, 32.6); gelado('Magnum Caramel e Nuts', 20, 37.2);
gelado('Magnum Double Hazelnut', 20, 32.6); gelado('Magnum Pistachio', 20, 32.6);
gelado('Magnum Sandwich', 20, 32.6); gelado('Max Push-Up Haribo', 30, 29.24);
gelado('Perna Pau', 30, 29.4); gelado('Rol', 28, 27.44);
drink('Coca Cola', 'Grade', 24); drink('Coca Cola Zero', 'Grade', 24);
drink('Compal Manga Laranja', 'Embalagem', 15); drink('Compal Pêssego', 'Embalagem', 15);
drink('Fanta Laranja', 'Grade', 24); drink('Fuze Tea Limão', 'Grade', 24);
drink('Fuze Tea Pêssego', 'Grade', 24); drink('Ginger Ale', 'Grade', 24);
drink('Ginger Beer', 'Grade', 24); drink('Guaraná', 'Embalagem', 6);
drink('Kombucha Folha de Figueira', 'Embalagem', 15); drink('Kombucha Gengibre', 'Embalagem', 15);
drink('Kombucha Hortelã-Pimenta', 'Embalagem', 15); drink('Sprite', 'Grade', 24);
drink('Espumante Valmarone Bruto', 'Caixa', 6);
drink('Vinho Branco', 'Caixa', 6); drink('Vinho Tinto', 'Caixa', 6);
drink('Gasosa Spaty 1.5L', 'Embalagem', 6);
for (const n of ['Pedras Salgadas', 'Pedras Salgadas Limão', 'Pedras Salgadas Maracujá', 'Pedras Salgadas Tangerina', 'Água Castello', 'Água Luso 50cl PET', 'Água Tónica Royal Bliss 25cl']) drink(n, 'Embalagem', 24);
drink('Água Luso 50CL Vidro', 'Grade', 20);
// Carnes / congelados
emb('Alheira (kg)', 'Embalagem', 1.5);
emb('Bacon Fatiado (embalagem)', 'Embalagem', 35);
producao('Bifana (embalagem)');
varPeso('Bifana (kg)'); varPeso('Chambão (kg)'); varPeso('Moelas (kg)');
producao('Chouriço (porção)'); producao('Frango Desfiado (kg)');
emb('Hamburguer (embalagem de 10)', 'Embalagem', 10);
producao('Hamburguer Alheira (un)'); producao('Hamburguer veg (un)');
varPeso('Maminha(porção)');
producao('Moelas (porções cozinhadas)');
varPeso('Peito de Frango (vasilha)');
producao('Pica Pau (porção)'); producao('Porção Taco de Rabo de Boi');
emb('Prego (embalagem de 10)', 'Embalagem', 10);
U.push(['Salsicha HotDog (frasco)', { pack: 8, packaging: pkg('Frasco', 8), parts: ['Frascos*8', 'Unidades'] }]);
emb('Abacate em Cubos', 'Saco', 1);
emb('Batata Frita Crispers (2.5kg)', 'Saco', 9, { parts: ['Sacos*9'] });
producao('Bolinhas de Alheira (porções)');
emb('Croquetes de Carne (uni)', 'Saco', 50);
varPeso('Filete Tilápia (750gr)', 'Saco'); varPeso('Gelado Baunilha (4.5L)', 'Cuba');
emb('Saco Gelo (kg)', 'Saco', 2);
producao('Taco Tilápia (porções)');
// Economato
emb('Palhinhas', 'Embalagem', 1, { packaging: pkg('Embalagem', 1, null, 1, { variable: true }) });
emb('Palitos Cocktail/Golf', 'Embalagem', 1, { packaging: pkg('Embalagem', 1, null, 1, { variable: true }) });
emb('Papel Higiénico', 'Embalagem', 12);
emb('Papel ZigZag WC Clientes (uni.)', 'Caixa', 24);
emb('Potes para Molho Maionese', 'Embalagem', 50);
emb('Rolos POS (uni)', 'Caixa', 10);
emb('Rolos TPA (uni)', 'Caixa', 8);
emb('Rolos de Papel Mãos (uni.)', 'Embalagem', 6);
emb('Sacos do Lixo 100L', 'Rolo', 10);
// Frios
emb('Chouriço', 'Embalagem', 2);
emb('Fiambre', 'Embalagem', 50, { notes: 'fatia ~40g' });
emb('Manteiga Gresso (1kg)', 'Embalagem', 1);
emb('Ovo Cozido', 'Balde', 24);
emb('Queijo Cheddar', 'Embalagem', 50, { notes: 'fatia ~25g' });
emb('Queijo Chévre (180gr)', 'Embalagem', 10);
emb('Queijo Emmental', 'Embalagem', 50, { notes: 'fatia ~25g' });
emb('Queijo Flamengo', 'Embalagem', 50, { notes: 'fatia ~25g' });
emb('Queijo Mozzarella', 'Embalagem', 50, { notes: 'fatia ~25g' });
emb('Queijo da Ilha', 'Embalagem', 0.4);
// Frutas & verduras (peso variável)
for (const n of ['Alho (kg)', 'Batata (kg)', 'Cebola (kg)', 'Cebola Roxa (kg)', 'Cenoura (kg)', 'Coentros (molho)', 'Espinafre (embalagem)', 'Hortelã (molho)', 'Laranja (kg)', 'Lima (kg)', 'Limão (kg)', 'Pepino (uni)', 'Tomate Runner (uni)']) varPeso(n);
U.push(['Alface Iceberg (uni)', { pack: 1, packaging: pkg('Unidade', 1), notes: '~500g' }]);
emb('Pickles (balde)', 'Balde', 2.3);
// Mercearia (só o que a folha detalha)
emb('Atum 785g', 'Lata', 785);
emb('Chocolate Barra (200gr)', 'Caixa', 2);
emb('Farinha de arroz', 'Embalagem', 500);
emb('Leite', 'Embalagem', 6);
emb('Leite Vegetal', 'Embalagem', 6);
U.push(['Maionese (balde)', { pack: 4.5, packaging: pkg('Balde', 4.5) }]);
emb('Nata Culinária', 'Embalagem', 6);
emb('Nozes', 'Embalagem', 1);
emb('Polpa de Tomate', 'Embalagem', 6);
emb('Topping Líquido Chocolate', 'Embalagem', 1);
U.push(['Tremoços (balde)', { pack: 3, packaging: pkg('Balde', 3) }]);
// Take away — variável
for (const n of ['Caixa Hamburguer', 'Caixa Tosta', 'Conjunto Talheres', 'Copo Sumo Natural', 'Palhinhas Individuais', 'Prato Fundo Bambu', 'Prato Raso Bambu', 'Prato Raso Cartão 21cm', 'Recipiente Guacamole/Humus', 'Recipiente Petisco', 'Recipiente Sopa', 'Sacos de Papel c/ asa']) varPeso(n);
U.push(['Copos Heineken (25cl)', { unit: 'un', packaging: pkg('Embalagem', 1, null, 1, { variable: true }) }]);
U.push(['Copos Heineken (50cl)', { unit: 'un', packaging: pkg('Embalagem', 1, null, 1, { variable: true }) }]);
for (const n of ['Tosta Honey & Cheese', 'Tosta Mamma Mia', 'Tosta Mista', 'Tosta Pollo Hermano', 'Tosta Tuna Turner']) producao(n);

const RENAMES = [['Solero', 'Solero Tropical'], ['Sacos Zip Lock (embalagem)', 'Sacos Zip Lock 3L (embalagem)']];
const NEW = [
  ['Solero Morango e Lima', 'bar', 'Gelados', 'Olá', 'un', 25, +(29.25 / 25).toFixed(4), 23, pkg('Caixa', 25)],
  ['Sacos Zip Lock 1L (embalagem)', 'kitchen', 'Economato', 'Aviludo', 'embalagem', 1, null, null, pkg('Embalagem', 10)],
  ['Sacos Zip Lock 5L (embalagem)', 'kitchen', 'Economato', 'Aviludo', 'embalagem', 1, null, null, pkg('Embalagem', 10)],
];

let updated = 0, missing = [], created = 0;
for (const [oldName, newName] of RENAMES) {
  await sql`UPDATE products SET name = ${newName} WHERE name = ${oldName}`;
}
U.push(['Solero Tropical', { pack: 25, packaging: pkg('Caixa', 25), price: +(29.25 / 25).toFixed(4), iva: 23 }]);
U.push(['Sacos Zip Lock 3L (embalagem)', { packaging: pkg('Embalagem', 10) }]);

for (const [name, f] of U) {
  const rows = await sql`
    UPDATE products SET
      unit = COALESCE(${f.unit ?? null}, unit),
      pack_size = COALESCE(${f.pack ?? null}, pack_size),
      packaging = COALESCE(${f.packaging ? JSON.stringify(f.packaging) : null}::jsonb, packaging),
      count_parts = CASE WHEN ${f.parts !== undefined} THEN ${f.parts ?? null} ELSE count_parts END,
      price_net = COALESCE(${f.price ?? null}, price_net),
      iva = COALESCE(${f.iva ?? null}, iva),
      notes = CASE WHEN ${f.notes !== undefined}
                   THEN CASE WHEN coalesce(notes,'') = '' THEN ${f.notes ?? ''}
                             WHEN position(${f.notes ?? ''} in notes) > 0 THEN notes
                             ELSE notes || ' · ' || ${f.notes ?? ''} END
                   ELSE notes END
    WHERE name = ${name} RETURNING id`;
  if (rows.length === 0) missing.push(name);
  else {
    updated++;
    if (f.convertLevels) {
      await sql`UPDATE stock_levels SET qty = qty * ${f.convertLevels} WHERE product_id = ${rows[0].id}`;
    }
  }
}
for (const [name, area, category, supplier, unit, pack, price, iva, packaging] of NEW) {
  const r = await sql`
    INSERT INTO products (name, area, category, supplier, unit, pack_size, price_net, iva, packaging)
    VALUES (${name}, ${area}, ${category}, ${supplier}, ${unit}, ${pack}, ${price}, ${iva}, ${JSON.stringify(packaging)}::jsonb)
    ON CONFLICT (name) DO NOTHING RETURNING id`;
  if (r.length) created++;
}
console.log(`atualizados: ${updated} · criados: ${created}`);
if (missing.length) console.log('NÃO ENCONTRADOS:', missing.join(' | '));
