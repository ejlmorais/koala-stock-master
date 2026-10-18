-- Stocks V2 — esquema de dados (Postgres schema "v2", na mesma base Neon).
-- Base: koala-bar/docs/requisitos-stocks-v2.md (versão 1, 18/10/2026).
-- As tabelas da V1 (schema public) ficam intactas; a V2 lê delas só na
-- importação do histórico. sales_days, sale_items, zs_products e app_settings
-- continuam partilhadas (não têm unidades de stock).
-- Idempotente: pode correr-se mais do que uma vez.

CREATE SCHEMA IF NOT EXISTS v2;

-- ─────────────────────────────────────────────────────────────────────────
-- Vocabulário fechado de unidades de stock
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2.units (
  code      text PRIMARY KEY,
  dimension text NOT NULL CHECK (dimension IN ('count', 'mass', 'volume')),
  label_sg  text NOT NULL,
  label_pl  text NOT NULL
);

INSERT INTO v2.units (code, dimension, label_sg, label_pl) VALUES
  ('un',     'count',  'unidade',    'unidades'),
  ('fatia',  'count',  'fatia',      'fatias'),
  ('porção', 'count',  'porção',     'porções'),
  ('g',      'mass',   'g',          'g'),
  ('kg',     'mass',   'kg',         'kg'),
  ('cl',     'volume', 'cl',         'cl'),
  ('L',      'volume', 'L',          'L')
ON CONFLICT (code) DO NOTHING;

-- Locais físicos da contagem (partições, não embalagens)
CREATE TABLE IF NOT EXISTS v2.count_locations (
  id     serial PRIMARY KEY,
  label  text NOT NULL UNIQUE,
  sort   integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

INSERT INTO v2.count_locations (label, sort) VALUES
  ('Frios', 1), ('Naturais', 2), ('Armazém', 3)
ON CONFLICT (label) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Produtos
--   unidade de stock  → unit (+ unit_label só para apresentação quando 'un')
--   recipiente        → container_name / container_qty (capacidade na unidade)
--   embalagem compra  → pack_name / pack_qty (em recipientes, ou em unidades
--                       quando não há recipiente) / pack_price_net
--   unidades por embalagem = pack_qty × COALESCE(container_qty, 1)
--   price_net (€/unidade) = pack_price_net ÷ unidades por embalagem
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2.products (
  id                serial PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  area              text NOT NULL CHECK (area IN ('bar', 'kitchen')),
  category          text,
  supplier          text,
  supplier_aliases  text[],                         -- nomes/códigos nos portais
  origin            text NOT NULL DEFAULT 'compra' CHECK (origin IN ('compra', 'producao')),

  unit              text NOT NULL REFERENCES v2.units (code),
  unit_label        text,                           -- garrafa, lata, cápsula… (só com unit = 'un')

  container_name    text,                           -- Garrafa, Barril, Embalagem, Lata
  container_qty     numeric(12,3),                  -- 70 (cl), 50 (L), 30 (fatias), 785 (g)

  pack_name         text,                           -- Grade, Caixa, Embalagem, Unidade
  pack_qty          numeric(12,3),                  -- recipientes (ou unidades) por embalagem; NULL = peso variável
  pack_nominal_qty  numeric(12,3),                  -- só variáveis: quantidade típica na unidade (Laranja ≈ 11 kg)
  pack_price_net    numeric(12,4),                  -- € s/IVA da embalagem (o que se escreve)
  price_net         numeric(14,6),                  -- € s/IVA por unidade (calculado; escrito nos variáveis)
  iva               numeric(5,2),

  min_level         numeric(14,4),                  -- ponto de encomenda, na unidade de stock
  count_locations   integer[],                      -- ids de v2.count_locations; NULL = campo único
  track_empties     boolean NOT NULL DEFAULT false, -- barris/botijas: campo «vazios», registado, não somado
  needs_recount     boolean NOT NULL DEFAULT false,

  notes             text,
  active            boolean NOT NULL DEFAULT true,
  legacy_id         integer,                        -- products.id na V1
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT products_label_only_for_un  CHECK (unit = 'un' OR unit_label IS NULL),
  CONSTRAINT products_container_pair     CHECK ((container_name IS NULL) = (container_qty IS NULL)),
  CONSTRAINT products_container_not_un   CHECK (unit <> 'un' OR container_qty IS NULL),
  CONSTRAINT products_container_positive CHECK (container_qty IS NULL OR container_qty > 0),
  CONSTRAINT products_pack_positive      CHECK (pack_qty IS NULL OR pack_qty > 0),
  CONSTRAINT products_purchase_has_pack  CHECK (origin = 'producao' OR pack_name IS NOT NULL),
  CONSTRAINT products_variable_nominal   CHECK (origin = 'producao' OR pack_qty IS NOT NULL OR pack_nominal_qty IS NOT NULL),
  CONSTRAINT products_production_no_pack CHECK (origin = 'compra' OR pack_name IS NULL)
);

CREATE INDEX IF NOT EXISTS products_legacy_idx ON v2.products (legacy_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Stock: nível atual + ledger (sempre na unidade de stock)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2.stock_levels (
  product_id integer PRIMARY KEY REFERENCES v2.products (id) ON DELETE CASCADE,
  qty        numeric(14,4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS v2.stock_movements (
  id         serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES v2.products (id) ON DELETE CASCADE,
  delta      numeric(14,4) NOT NULL,
  reason     text NOT NULL CHECK (reason IN
               ('count', 'sale', 'reception', 'production', 'waste', 'manual', 'import', 'unit_change')),
  ref_type   text,                                  -- count | sale_day | reception_line | production_log | legacy
  ref_id     text,
  factor     numeric(12,6),                         -- só em unit_change
  note       text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON v2.stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_ref_idx     ON v2.stock_movements (reason, ref_type, ref_id);

-- Contagens: o que foi escrito (entries) e o total calculado no servidor.
-- entries: [{"location_id": 1, "label": "Frios", "containers": 3, "loose": 13, "qty": 85}, …]
--   containers = recipientes (fração permitida: 1,3 garrafas); loose = soltos na unidade;
--   qty = containers × container_qty + loose. Sem recipiente: só loose.
CREATE TABLE IF NOT EXISTS v2.stock_counts (
  id           serial PRIMARY KEY,
  product_id   integer NOT NULL REFERENCES v2.products (id) ON DELETE CASCADE,
  qty          numeric(14,4) NOT NULL,
  entries      jsonb NOT NULL,
  empties      numeric(12,3),                       -- vazios registados, não somados
  previous_qty numeric(14,4),
  note         text,
  counted_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_counts_product_idx ON v2.stock_counts (product_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Receitas de venda (Zonesoft → stock) e de produção (cru → produzido)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2.recipes (
  id         serial PRIMARY KEY,
  zs_code    text NOT NULL,                         -- código do artigo no Zonesoft (zs_products.code)
  product_id integer NOT NULL REFERENCES v2.products (id) ON DELETE CASCADE,
  qty        numeric(12,4) NOT NULL CHECK (qty > 0),-- na unidade do produto, por venda
  source     text,                                  -- editor | import-v1 | ligação 1:1
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zs_code, product_id)
);

CREATE INDEX IF NOT EXISTS recipes_product_idx ON v2.recipes (product_id);

-- Um ingrediente por produto produzido (âmbito da V2)
CREATE TABLE IF NOT EXISTS v2.production_inputs (
  product_id       integer PRIMARY KEY REFERENCES v2.products (id) ON DELETE CASCADE,  -- produzido
  input_product_id integer NOT NULL REFERENCES v2.products (id),                        -- cru
  qty_per_output   numeric(12,4) NOT NULL CHECK (qty_per_output > 0),                  -- cru por 1 unidade produzida
  CHECK (product_id <> input_product_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Encomendas e receções (passam do koala-bar para aqui)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2.orders (
  id           serial PRIMARY KEY,
  supplier     text NOT NULL,
  status       text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'enviada', 'recebida', 'cancelada')),
  external_ref text UNIQUE,                         -- «eazle:12345» quando vem de um portal
  expected_on  date,
  note         text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ordered_at   timestamptz,
  closed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS v2.order_lines (
  id             serial PRIMARY KEY,
  order_id       integer NOT NULL REFERENCES v2.orders (id) ON DELETE CASCADE,
  product_id     integer NOT NULL REFERENCES v2.products (id),
  pack_name      text,                              -- snapshot da embalagem no momento da encomenda
  pack_qty       numeric(12,3),
  container_qty  numeric(12,3),
  packs          numeric(12,3),                     -- embalagens pedidas (NULL nos variáveis)
  units          numeric(14,4) NOT NULL,            -- pedido na unidade de stock
  received_units numeric(14,4) NOT NULL DEFAULT 0,
  not_coming     boolean NOT NULL DEFAULT false,
  to_confirm     boolean NOT NULL DEFAULT false,    -- portal diz embalagem diferente do catálogo
  portal_text    text                               -- linha original do portal, só para consulta
);

CREATE INDEX IF NOT EXISTS order_lines_order_idx ON v2.order_lines (order_id);

CREATE TABLE IF NOT EXISTS v2.receptions (
  id          serial PRIMARY KEY,
  order_id    integer NOT NULL REFERENCES v2.orders (id) ON DELETE CASCADE,
  received_by text,
  received_at timestamptz NOT NULL DEFAULT now(),
  invoice_ref text,
  note        text
);

CREATE TABLE IF NOT EXISTS v2.reception_lines (
  id            serial PRIMARY KEY,
  reception_id  integer NOT NULL REFERENCES v2.receptions (id) ON DELETE CASCADE,
  order_line_id integer NOT NULL REFERENCES v2.order_lines (id) ON DELETE CASCADE,
  packs         numeric(12,3),                      -- embalagens recebidas
  loose         numeric(14,4),                      -- soltos na unidade (ou kg nos variáveis)
  units         numeric(14,4) NOT NULL              -- total lançado no stock, calculado no servidor
);

-- ─────────────────────────────────────────────────────────────────────────
-- Registo de produção
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2.production_logs (
  id               serial PRIMARY KEY,
  product_id       integer NOT NULL REFERENCES v2.products (id),
  qty              numeric(14,4) NOT NULL CHECK (qty > 0),  -- produzido, na unidade do produto
  input_product_id integer REFERENCES v2.products (id),
  input_qty        numeric(14,4),                           -- cru consumido
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
