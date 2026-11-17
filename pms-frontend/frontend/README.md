# Pharmacy Management – web app

React + TypeScript front end for the Pharmacy Management System. It talks to the NestJS API in `../backend`.

Works on a desktop browser and on tablets. The point of sale keeps working without a connection.

## What is in it

| Area | Screens |
|---|---|
| Overview | Role dashboards, approvals inbox, notifications and alert preferences |
| Selling | Point of sale (online and offline), sales history and receipts, customer returns with inspection, customers (statement, payments), prescriptions, cash register open/close, offline queue |
| Stock | Products (details, packs, barcodes, prices, photo), import from CSV, bulk price changes, stock views (by product, batch, low, expiring, movements, value), adjustments, disposals, transfers, counts |
| Buying | Suppliers (account, statement, performance), reorder suggestions, purchase requests and orders, goods receipts and inspection, supplier invoices, payments, returns |
| Finance | Expenses, other income, journal and manual entries, chart of accounts and mapping, fiscal periods, statements, register sessions |
| Reports | 13 reports with period and branch filters, export to Excel, PDF or CSV |
| Setup | Branches, warehouses and locations, registers, employees, users, roles and permissions, product lists, tax, payment methods, settings, numbering, tablets, offline problems, background jobs, audit log |

Menus and buttons appear only for what the signed-in person is allowed to do. The server checks every request as well.

## Run it

```bash
cd backend && npm run build && node dist/main.js     # API on :3000 (see backend/README.md for env vars)
cd frontend
npm install
npm run dev                                          # http://localhost:5173, /api is proxied to :3000
```

Demo data (after `npm run demo-data` in the backend): sign in as `admin` or the demo users listed in the backend README.

## Build and deploy

```bash
npm run build        # type-checks, then writes dist/
npm run preview      # serves dist/ on :4173 (also proxies /api)
```

Serve `dist/` from any static host **behind the same domain as the API** (for example nginx: `/` → dist, `/api/` → backend). If the API is on another domain, build with `VITE_API_URL=https://api.example.com/api/v1` and add the web address to the API's `CORS_ORIGINS`.

HTTPS is required in production for the offline support to install (service workers only run on HTTPS or localhost).

## Offline point of sale

1. A tablet opens the point of sale once while online. It registers itself and downloads the product list, prices, tax rules, payment methods and stock levels into the browser (IndexedDB).
2. The app installs a service worker, so it opens even if the tablet is restarted without a connection. Use "Add to home screen" for a full-screen till.
3. Without a connection a sale is priced and taxed on the tablet, kept in a queue, and a provisional receipt is shown. Sales on credit and prescription-only items need a connection.
4. When the connection returns the queue uploads automatically (also from the Offline sales page). Each sale is checked again by the server. Anything it cannot accept (for example stock that is no longer there) shows up as a problem for a manager under Setup → Offline sale problems.

The server decides the real price and tax as of the time of sale, so a price change made while a tablet was offline never silently changes a sale.

Browser notes: printing uses the browser's print dialog (set the thermal printer as the default for the tablet and choose 80 mm paper). Barcode scanners that act as a keyboard work as they are: scan into the search box.

## How it is organised

```
src/
  lib/       api client (tokens, refresh, errors), auth and branch context, navigation, formatting
  domain/    money and tax maths, units, barcodes, receipt layout (same code as the server)
  ui/        shared building blocks: tables, forms, modals, resource and document pages
  pages/     one file per area (admin, catalog, stock, sales, buying, finance, insight)
  pos/       point of sale screen and the offline engine (sync, queue, local search)
```

Most list screens are short configurations of two generic pages (`ResourcePage`, `DocumentPage`) so behaviour stays consistent. The API contract is `../docs/pms-openapi.json`; `npm run api-types` regenerates `src/api/schema.d.ts` from it.

## Things to know

* Tokens: access token in session storage, refresh token in local storage. Signing out everywhere ends all sessions.
* The last known user profile is kept so a tablet can open offline. It is only used to decide what to show; the server still enforces permissions.
* The provisional receipt printed offline carries the receipt number the tablet made up (`OFF-…`). The real receipt number is assigned when the sale uploads.
* Tax rates, prescription rules, e-invoicing and the fiscal calendar are settings. The sample values must be confirmed with ERCA, EFDA and your accountant before go-live.
