# koala-stock

Backend-only stock manager for the Koala bar. Three modules, one Postgres database, deployed on Vercel and consumed by the koala-bar frontend.

1. **Stock Controller** — bar and kitchen stock, updated manually by users or automatically by sales (decrease) and received orders (increase). Every change is a ledger entry in `stock_movements`.
2. **Sales Record** — daily sales pulled from the Zonesoft ZSBMS backoffice (`zsbmsv2.zonesoft.org`), stored per product per day, with top-sellers, week-over-week variation and statistical outlier alerts.
3. **Orders Manager** — purchase orders per supplier; receiving an order increases stock for all its items.

Stack: Next.js 15 (API routes only, no UI) + Neon serverless Postgres — same as koala-bar.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in:
   - `DATABASE_URL` — Neon connection string (can be a separate database in the same Neon project as koala-bar)
   - `STOCK_API_KEY` — any long random string; koala-bar sends it on every request
   - `CRON_SECRET` — random string; add the same value in Vercel project settings so Vercel Cron can call the daily sync
   - `ALLOWED_ORIGINS` — e.g. `https://koala-bar.vercel.app,http://localhost:3000` (only needed if the browser calls this API directly)
   - `ZONESOFT_NIF`, `ZONESOFT_USERNAME`, `ZONESOFT_PASSWORD` — the same credentials used to log in at zsbmsv2.zonesoft.org
3. `npm run db:setup` — creates all tables (idempotent)
4. **`npm run zonesoft:probe`** — verifies the Zonesoft login + report protocol with your real credentials and dumps the raw report to `zonesoft-raw.json`. Do this before relying on the daily sync — see "Zonesoft caveat" below.
5. `npm run dev` — local server on port 3001
6. Deploy: push to a Git remote, import into Vercel, set the same env vars. `vercel.json` schedules the daily sales sync at 06:30 UTC.

## Auth

Every `/api/*` route except `/api/health` requires the key:

```
Authorization: Bearer <STOCK_API_KEY>     (or x-api-key: <STOCK_API_KEY>)
```

Vercel Cron is authorized separately via `CRON_SECRET`.

## Endpoints

### Products (catalog + Zonesoft mapping)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/products?area=bar&all=true` | list (active by default) with total stock |
| POST | `/api/products` | `{ name, unit?, area?, zonesoft_name?, units_per_sale?, min_level? }` |
| GET/PATCH/DELETE | `/api/products/{id}` | DELETE is a soft-deactivate |

`zonesoft_name` links a product to its name in ZSBMS sales; `units_per_sale` is how much stock one sold unit consumes (e.g. `0.04` for a 4 cl pour from a 1 L bottle when you track litres); `min_level` drives low-stock alerts.

### Stock

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/stock?area=bar` | current levels |
| POST | `/api/stock/adjust` | `{ product_id, delta }` (relative) or `{ product_id, qty }` (absolute count after inventory); optional `area`, `note`, `created_by` |
| GET | `/api/stock/movements?product_id=&area=&reason=&limit=` | the ledger |
| GET | `/api/stock/alerts` | products at or below `min_level` |

### Sales

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/sales/sync` | `{ date }` or `{ from, to }`; defaults to yesterday; idempotent (re-sync reverses and re-applies stock). Closed weekdays (`CLOSED_WEEKDAYS`, default Monday) are skipped unless `force: true` |
| GET | `/api/sales/sync` | cron entry point — syncs yesterday (skips closed weekdays) |
| GET | `/api/sales?from=&to=&items=true` | daily totals, optionally with per-product items |
| GET | `/api/sales/top?days=7&by=qty\|gross&limit=20` | top sellers |
| GET | `/api/sales/weekly?weeks=8` | weekly totals + per-product change vs last week (business weeks: Tuesday → Sunday) |
| GET | `/api/sales/outliers?date=&window=28&z=2` | products whose qty deviates ≥ z std-devs from their trailing mean, plus a same-weekday day-total check |

Synced sale items whose name matches a product's `zonesoft_name` (or `name`) automatically decrease that product's stock by `qty × units_per_sale` in the product's area.

### Orders

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/orders?status=draft\|ordered\|received\|cancelled` | list with totals |
| POST | `/api/orders` | `{ supplier, note?, status?, items: [{ product_id, qty, unit_cost?, area? }] }` |
| GET/PATCH/DELETE | `/api/orders/{id}` | PATCH replaces `items` when given; received orders are immutable |
| POST | `/api/orders/{id}/receive` | marks received and **increases stock** for every item; optional `{ received_by }` |

## Calling from koala-bar

```ts
// koala-bar: src/lib/stock-api.ts
const BASE = process.env.STOCK_API_URL!;   // e.g. https://koala-stock.vercel.app
const KEY = process.env.STOCK_API_KEY!;    // same value as in koala-stock

export async function stockApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      ...init?.headers,
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`stock API ${path}: ${res.status}`);
  return res.json();
}
```

Calling server-side from koala-bar (server components / server actions) keeps the key secret and avoids CORS entirely.

## Zonesoft integration (verified July 2026)

ZSBMS has no public API. The client in [src/lib/zonesoft.ts](src/lib/zonesoft.ts) implements the protocol reverse-engineered from the backoffice web app and verified end-to-end against the live account:

1. `POST https://auth.zonesoft.org/token` → anonymous session pair `{ tk_key, tk }`
2. `POST https://auth.zonesoft.org/login` with `{ nif, username, passwd }`
3. `POST https://client.zonesoft.org/Report/getReport/` with `rptID: "vprod"` ("Volume de Vendas por Produto"), dates as `DD-MM-YYYY`, store filter `f_lojas: [1]`
4. The response contains download links; the `excel` link on static.zonesoft.org is actually an HTML table (windows-1252) which is downloaded and parsed into `{ code, name, qty, gross }` rows

Every request wraps its payload as `{ Container: [...], Metadata: { [tk_key]: tk } }`, carries the PHPSESSID cookie, and **must** send `X-Requested-With: XMLHttpRequest` plus a browser User-Agent — without those the auth server returns an empty body.

The raw report HTML is stored in `sales_days.raw` on every sync, so history can be reprocessed if parsing ever needs to change. Extra/changed report filters can be injected without code changes via `ZONESOFT_REPORT_DATA` (JSON merged into `Data`), e.g. `{"f_lojas":[1,2]}` if a second store is added.

`npm run zonesoft:probe -- 2026-07-24` fetches and prints one day without touching the database — useful to sanity-check after any Zonesoft update.
