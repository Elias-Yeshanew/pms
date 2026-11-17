# Progress tracker

Updated: 2 Nov 2026

## Completed and tested
| Milestone | Summary |
| --- | --- |
| 1. Foundation | Authentication, sessions, lockout, password policy and recovery, RBAC with branch scope, users, roles, branches, employees, audit log |
| 2. Settings and catalog | Settings engine, document numbering, tax rules, warehouses, registers, suppliers, products with pack sizes, barcodes, price history, exact decimal maths |
| 2b. Catalog extras | CSV import with dry-run preview, bulk price updates with approval, barcode generation and SVG labels, verified image upload |
| 3. Inventory | Stock ledger (single posting path, database guard, reconciliation), batches, FEFO, approvals engine, adjustments, quarantine, disposals, expiry, transfers, physical counts, stock reports |
| 4. Procurement | Reorder suggestions, purchase requests and orders (with tax, credit limit, approved changes), receiving into quarantine, inspection, three-way invoice matching, payments (partial, reversible), supplier credits and returns, statements, aging, price comparison, supplier performance |

Automated tests: **205 passing** (34 unit, 171 end-to-end against a real PostgreSQL database).

## Milestone 4 details
| Area | Status | Notes |
| --- | --- | --- |
| Purchase requests, approval, conversion to orders | Done | |
| Purchase orders: tax per line, drafts, approval, credit limit, revisions with approval, cancel, close | Done | revision numbers never reused |
| Receiving: partial deliveries, over-receipt tolerance, expiry check, batch with true cost | Done | goods land in quarantine |
| Inspection: accept / reject with reason, optional separate inspector | Done | rejected goods move to damaged |
| Supplier invoices with three-way matching and tolerance approval | Done | invoices must reference an order |
| Payments: partial, multi-invoice, atomic, reversal without deletion | Done | tested under simultaneous payments |
| Returns to suppliers and supplier credits applied to invoices | Done | |
| Supplier balance, statement, payables aging | Done | |
| Price comparison per base unit, supplier performance | Done | |

## Known gaps and decisions
- **Finance postings:** payables, receipts and write-offs are recorded but not yet posted to a general ledger. That is Milestone 6; the data needed is already captured.
- **Purchase cost and tax:** batch cost is net of tax. Whether input tax is recoverable, and how, is a question for the accountant.
- Stock reservation, notifications (expiry, low stock, overdue orders and invoices) and scheduled jobs (expiry sweep) arrive with Milestone 7.
- Approval rules are on/off settings per document type. Amount-based thresholds and multi-step chains are not built.
- `product_suppliers.last_price` is now set from inspected deliveries and is per base unit; prices entered by hand through the supplier-product endpoint should follow the same convention.
- Image storage is local disk. Moving to object storage later only touches `MediaService`.
- Two-factor authentication, per-user permission override endpoints, real email delivery, proxy trust setting, Docker/CI files: unchanged from earlier notes.
- `tax.prices_include_tax`, every tax rate, rounding rule and prescription rule remain placeholders to confirm with ERCA, EFDA and the accountant.

## Next
Milestone 5: sales and POS backend: sales with FEFO allocation, payments (split, cash, electronic), discounts with approval limits, tax, receipts, returns and cancellations, customers, prescriptions, credit sales.

## Milestone 5 – Sales, POS, customers, prescriptions (complete)
Tested: 38 unit + 203 end-to-end tests pass (32 for sales).
- Sales with exact tax/discount maths, FEFO allocation with batch cost, split payments, change, idempotent retries, approved discounts.
- Customers with append-only account ledger, credit limits, payments and reversal, statements, reconcile.
- Prescriptions (configurable required fields, validity, attachments, dispensing limits, restricted view with audit).
- Cancellation (four-eyes), returns to quarantine with independent inspection, refunds, thermal receipts (58/80 mm) with reprint log.
Known follow-ups: hide cost/profit fields from users without finance rights; tidy the refunds query in SalesService.summary.
Still to build: M6 finance ledger, M7 offline sync + notifications, M8 reports/dashboards, deployment/hardening.

## Milestone 6 – Finance (complete)
Tested: 38 unit + 219 end-to-end tests pass (16 new finance tests).
- Chart of accounts (editable), posting-account mappings (re-pointable, per payment method), fiscal periods (open/close/reopen with reason), balanced append-only double-entry journal (database refuses unbalanced or edited entries), manual journals (four-eyes).
- Automatic postings, in the same transaction as the business event: stock movements (receipt, sale/COGS, returns, cancellations, adjustments, counts, disposals, transfers, purchase returns, opening balances), sales revenue + tax, customer payments, sales returns, supplier invoices/payments/credits, expenses, other income, register variances.
- Expenses with approval above a configurable amount, other income, reversal instead of deletion.
- Cash register sessions: opening float, expected cash worked out from activity, counted close, variance posted to cash over/short; optional "must open session to sell".
- Reports: trial balance, income statement (revenue, COGS, gross profit, stock losses, operating expenses, net operating profit), branch performance, balance sheet, cash flow summary, tax summary, general ledger, daily closing; `/finance/reconcile` checks inventory, receivables and payables against their sub-ledgers.
- Cost and profit fields are hidden from users without `finance.read`.
Decisions to confirm with the accountant: GRNI treatment of price variances, tax accounts (ERCA/VAT rules are configuration), fiscal calendar (Ethiopian year periods are created as explicit date ranges).

## Milestone 7 – Notifications, jobs, offline sync (complete)
- Notifications with de-duplication, branch- and permission-aware visibility, read state, per-user preferences, email stub; scheduled checks for low/out-of-stock, expiry, overdue orders, supplier payments due, overdue customers, approval reminders, unusual adjustments, cash variance, audit-table creation.
- Offline sync: registered devices (revocable), change feed driven by database triggers, paged snapshots, branch stock hint, batch upload of offline sales (idempotent, one by one), priced and taxed as of the sale time, offline-window limit, conflicts for a manager with retry (by the original cashier) or dismiss (with a reason).
- Not built: stock reservations (the column exists; nothing writes it), accepting a conflict by forcing stock negative (deliberately left out so the stock ledger stays truthful).
- Found and fixed: the audit log's monthly tables were only created at install time; a daily job now creates the next three months.

## Milestone 8 – Reports, dashboards, export (complete)
- 14 reports: sales by day/product, top products, payment methods, employee performance, discount analysis, branch comparison, product profitability, stock valuation, expiry exposure, slow movers, stock turnover/cover, supplier performance.
- 5 role dashboards (CEO, pharmacy manager, supply chain, sales manager, dispenser) from the same reports; needs the new `dashboards.management` permission (dispenser view excepted).
- Excel (numbers stay numbers), PDF (printable, paged) and CSV export; every export is audited.
- Cost, value and profit columns are removed for users without `finance.read`. Branch scope is enforced in every query.
- Period handling uses the shop's time zone and whole days; weeks start on Monday.
- Financial statements (trial balance, income statement, balance sheet, cash flow, tax summary) remain under `/finance/...` and have no file export yet.

## Hardening and deployment
- Dockerfile, docker-compose (API, PostgreSQL, daily backups), CI workflow, `TRUST_PROXY`, `.env.production.example`, `docs/DEPLOYMENT.md`, `npm run demo-data`.
- Not built: two-factor sign-in, per-user permission override endpoints, real email delivery, Ethiopian e-invoicing adapter (requirements not yet confirmed), exporting financial statements.
- The Docker files were written but not run here (no container runtime in the build environment). Run `docker compose up --build` once on a real machine before relying on them.

## Front end (complete)
- React + TypeScript web app in `frontend/`: all modules (selling, stock, buying, finance, reports, setup), tablet POS with offline queue, installable PWA. See `frontend/README.md`.
- Verified in a real browser: online sale, offline sale queued and uploaded on reconnect, cold start offline, purchase order → approval → receipt → inspection, prescription gating, report export. Every route loads without errors.
- Backend change made along the way: colliding DTO class names were renamed so the OpenAPI document is correct (goods receipt, transfer receive, reasons, categories). 15 e2e suites (240 tests) and 41 unit tests pass.
- Not covered: secondary screens were checked only to load; thermal printing goes through the browser print dialog; the service worker needs HTTPS in production.
