# Pharmacy Management System: Backend

NestJS (Node.js, TypeScript) and PostgreSQL. Modular monolith. SQL-first data access (`pg`, no ORM) with versioned SQL migrations.

## Requirements
- Node.js 22 or newer
- PostgreSQL 16 or newer

## First run
```bash
cd backend
npm install
cp .env.example .env          # then edit DATABASE_URL and JWT_ACCESS_SECRET
BOOTSTRAP_ADMIN_USERNAME=admin BOOTSTRAP_ADMIN_PASSWORD='choose-a-strong-one-1' npm run seed   # applies migrations, then seeds roles, units, forms and the first admin
npm run build && npm start    # or: npm run start:dev (the server also applies pending migrations on start)
```
- API base: `http://localhost:3000/api/v1`
- Interactive API docs (OpenAPI): `http://localhost:3000/api/docs` (set `SWAGGER_ENABLED=false` in production)
- The bootstrap administrator must change the password at first sign-in.

## Tests
```bash
npm test            # unit tests, then end-to-end tests against a real PostgreSQL database
```
End-to-end tests use `TEST_DATABASE_URL` (default `postgres://pms:pms_dev_pw@localhost:5432/pms_test`). The database must exist; the tests create the schema themselves and **wipe its data**, so never point it at a real database.

## Structure
```
src/
  common/            request context, error format, branch Scope, pagination, decorators
  config/            validated environment (zod)
  database/          pg pool + transactions, SQL migrations and runner
  modules/
    audit/           append-only audit log service and API
    iam/             authentication, sessions, users, roles, permissions, access guard
    org/             branches, departments, employees, warehouses, storage locations, cash registers
    platform/        settings engine (typed registry), document numbering
    finance/         tax categories and effective-dated tax rules, tax calculation
    procurement/     suppliers, purchase requests and orders, receiving and inspection, supplier invoices, payments, credits, returns, supplier analysis
    catalog/         units, categories, manufacturers, dosage forms, products, pack sizes, barcodes, prices, CSV import, bulk price updates, barcode labels, product images
    inventory/       stock ledger, batches, FEFO, adjustments, disposals, quarantine, expiry, transfers, physical counts, stock reports
    sales/           point of sale, payments, discounts, customers and credit, prescriptions, cancellations, returns, receipts
    finance/         (also) double-entry journal, chart of accounts, fiscal periods, expenses, income, cash register sessions, financial reports
    notifications/   alerts, scheduled background checks, email stub
    sync/            offline devices, change feed, offline sales upload and conflicts
    reports/         operational reports, role dashboards, Excel / PDF / CSV export
  domain/            exact decimal arithmetic, unit conversion, tax and discount maths (no framework code)
  seed/              permission catalog, built-in roles, bootstrap administrator
test/                end-to-end tests
scripts/             demo-data loader (uses the public API)
deploy/              production environment template
```

## Key rules implemented
- Routes are closed by default; only `@Public()` routes are open.
- Every request re-checks that its session is active and the user is active, so logout, deactivation and revocation take effect immediately.
- Branch scope is applied in the backend on every query (`Scope.sql`) and on every write.
- Roles and permissions cannot be used to escalate: you can only grant or remove a role whose permissions you hold for the same branch scope.
- There is always at least one active company-wide System Administrator.
- Audit log and login history are append-only (database triggers); secrets are redacted before logging.
- Refresh tokens rotate; replaying an old one revokes the session.
- Edits use optimistic concurrency (`version`) and return 409 on conflict.

## Money and quantities
Amounts and quantities are strings with at most 4 decimal places and are handled with exact integer arithmetic (`src/domain`), never floating point. Stock is stored in a product's base unit (for example tablets); strips, boxes and cartons are conversion factors. A conversion that would need rounding is refused instead of rounded.

## Settings and numbering
All client-specific behaviour lives in settings (`GET /settings`): security rules, currency, time zone, expiry warning days, discount limit, receipt options, offline limit, and more. Reference numbers (`PO-000123`, `S-2026-000045`, ...) come from configurable sequences taken inside the same transaction as the document, so a rolled-back document leaves no gap.

## Inventory rules (Milestone 3)
- **One door for stock.** Every quantity change goes through `LedgerService.post`: it locks the balance rows in a fixed order, refuses to go below zero (unless `inventory.allow_negative_stock` is on), and writes an append-only movement. A database trigger rejects any other attempt to change a balance. `GET /inventory/reconcile` compares every balance with the sum of its movements and must return an empty list.
- **FEFO.** Sales allocate earliest-expiry-first from `available`, unexpired stock only (`InventoryService.issueFefo`, used by the sales module). Expired, quarantined and damaged stock is never offered. Rows are locked in expiry order so simultaneous sales cannot take the same units.
- **Four-eyes approvals.** Adjustments, disposals, transfers and count corrections are approved by someone other than the requester, enforced in code and by a database constraint. Each can be switched to immediate posting in settings, in which case the poster needs the approval permission.
- **Quantities are base units** (for example tablets). Requests may use any pack size; conversion is exact or refused.
- **Transfers** take stock out of the source at dispatch and put it into the destination at receipt, with the same batch and expiry; shortfalls need a reason and a review by a second person. Stock in transit is included in valuation.
- **Counts** correct stock by the difference found against a snapshot, so sales made during the count are kept.

## Procurement rules (Milestone 4)
- **Request to payment:** reorder suggestion, purchase request, approval, purchase order, approval, delivery, receipt into **quarantine**, inspection (accepted goes to saleable stock, rejected goes to damaged), supplier invoice, payment.
- **Four-eyes** on requests, orders, order changes, out-of-tolerance invoices and returns. Each can be switched to immediate in settings.
- **Three-way matching:** an invoice is compared with the value of goods actually accepted; beyond `procurement.invoice_tolerance_percent` it needs approval.
- **Cost** of a batch is the net price per base unit from the order line, so valuation and gross profit use real purchase cost.
- **Payments** can be partial and are reversed, never deleted. Returns to suppliers create credits that are applied to invoices.
- **Credit limit** (`procurement.enforce_credit_limit`) blocks orders that would take a supplier past its limit; a limit of 0 means no limit.

## Bulk catalog tools (Milestone 2b)
- **CSV import:** `GET /products/import/template`, then `POST /products/import/preview` (a dry run that is rolled back, so nothing is created and no SKU numbers are used), then `POST /products/import/:id/commit`.
- **Bulk price update:** preview a percentage, amount or fixed price for a category, manufacturer or list of products; a second person approves; applying is refused if any price changed since the preview.
- **Labels:** `GET /products/:id/barcodes/:barcodeId/label` returns an SVG; `POST /products/labels/sheet` returns a printable page. `POST /products/:id/barcodes/generate` creates an in-store EAN-13.
- **Images:** PNG, JPEG or WebP up to 2 MB, identified by file content. Files are stored under `UPLOAD_DIR` with generated names, outside any public folder, and served only through the authenticated API.

## Time and concurrency notes
- Calendar dates are returned as plain `YYYY-MM-DD` text, never shifted by the server's time zone.
- Anything whose order matters under contention (price periods, stock movements) is stamped with the real clock time rather than the transaction start time.

## Finance (Milestone 6)
Every stock movement, sale, return, supplier invoice, payment, expense and cash difference posts a balanced, append-only journal entry in the same transaction as the business event. Mistakes are fixed by reversing entries, never edits. Closed fiscal periods refuse postings. Accounts are found through editable posting-account mappings, so a client can use its own chart of accounts. `GET /finance/reconcile` proves the books agree with stock, customer accounts and supplier invoices.

## Notifications and background checks (Milestone 7)
Alerts are raised once per condition and cleared when the condition clears. Who sees an alert depends on their permissions and branches. Checks run inside the API (`JOBS_ENABLED`); see `GET /jobs`.

## Offline sync (Milestone 7)
Tablets register as devices, download reference data (`/sync/snapshot/:entity`), follow `/sync/changes?since=`, and upload sales with `POST /sync/sales`. Offline sales are priced and taxed as of the time they were made, are safe to send twice, and the ones the server cannot accept are kept as conflicts for a manager. Stock reservations are not built.

## Reports and dashboards (Milestone 8)
`GET /reports` lists what you may run; `GET /reports/:code?period=this_month&branchId=` runs one; `/reports/:code/export?format=xlsx|pdf|csv` downloads it. Periods: today, yesterday, last_7_days, last_30_days, this_week, last_week, this_month, last_month, this_quarter, this_year, custom (`from`, `to`). Dashboards: `GET /dashboards/{ceo,pharmacy_manager,supply_chain,sales_manager,dispenser}`. Cost and profit columns appear only for people with `finance.read`.

## Deployment
See `../docs/DEPLOYMENT.md` (Docker, backups and restore, upgrades, monitoring, security checklist). `npm run demo-data` loads sample data on a fresh installation.
