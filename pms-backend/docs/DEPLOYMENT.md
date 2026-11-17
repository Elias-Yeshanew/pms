# Deployment and operations guide

One installation serves one client. Everything below is per client.

## 1. What you need
- A Linux server (2 CPU, 4 GB RAM is enough for a few branches), Docker with the compose plugin, and a domain name with HTTPS in front (Caddy or nginx).
- Outbound internet is not required at run time.

## 2. First install
1. `cp deploy/.env.production.example .env` and fill in every value. Generate the secret with `openssl rand -base64 48`.
2. `docker compose up -d --build`. The API applies database migrations itself before it accepts traffic.
3. `docker compose run --rm api node dist/seed/seed-cli.js` creates permissions, built-in roles, units and the first System Administrator from `BOOTSTRAP_ADMIN_*`. The administrator must change the password at first sign-in. Remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env` afterwards.
4. Put HTTPS in front. Example Caddyfile: `pharmacy.example.com { reverse_proxy 127.0.0.1:3000 }`. `TRUST_PROXY=1` is already set in compose so client addresses in logs and rate limits are the real ones.
5. Check `https://pharmacy.example.com/api/v1/health/ready` returns `{"status":"ok"}`.
6. Optional, sample data for a demo or training copy only: `DEMO_ADMIN_PASSWORD=... API_URL=https://.../api/v1 npm run demo-data` (needs a checkout of the repository). It refuses to run if branches already exist.

## 3. Configuration that is not in `.env`
Business rules live in Settings inside the application (tax, rounding, discount limits, approval rules, offline window, notification thresholds, fiscal calendar). Tax categories and rules are data: add the rates that apply in the client's country and set their effective dates. Nothing here is hard-coded to Ethiopia.

## 4. Backups
- Compose runs a `backup` container that writes a compressed dump to `./backups` every 24 hours and keeps 14 days. Copy that folder off the server (another machine or object storage) every day. A backup on the same disk is not a backup.
- Also keep the `uploads` volume (product images, prescription attachments).
- **Restore** (to a new or empty database): `docker compose stop api && docker compose exec -T db dropdb -U pms pms && docker compose exec -T db createdb -U pms pms && docker compose exec -T db pg_restore -U pms -d pms --no-owner < backups/pms-YYYYMMDD-HHMM.dump && docker compose start api`.
- Test a restore on a spare machine at least once a quarter and after every upgrade of PostgreSQL.

## 5. Upgrading
1. Take a backup. 2. `git pull` (or unpack the new release). 3. `docker compose up -d --build`. Migrations run automatically and only move forward; there is no automatic downgrade, which is why step 1 matters.

## 6. Background checks
Alerts (low stock, expiry, overdue orders, supplier payments due, unusual adjustments), email sending, housekeeping and the creation of next months' audit tables run inside the API every minute. `JOBS_ENABLED=false` turns them off on a copy that must not run them (for example a second API instance; leave exactly one instance on). Managers with the `jobs.run` permission can see and start each check from the API (`GET /jobs`, `POST /jobs/:name/run`).

## 7. Monitoring
- Liveness `GET /api/v1/health/live`, readiness `GET /api/v1/health/ready` (checks the database). Docker uses readiness as its health check.
- Every response carries a request id; errors return it, and it appears in the logs and the audit trail. Ask users to quote it when they report a problem.
- Watch: disk space (database and backups), the age of the newest file in `./backups`, and failing jobs (`GET /jobs` shows last result and error).

## 8. Offline tablets
Each tablet is registered once (`POST /sync/devices`) and can be revoked by a manager. Offline sales are accepted for as long as `offline.max_offline_hours` allows; sales the server cannot accept (for example not enough stock when the tablet reconnects) are held as conflicts for a manager to review. See the Frontend Integration Guide, section "Offline sync".

## 9. Security checklist before go-live
- `SWAGGER_ENABLED=false` in production (the API documentation is not for the public internet).
- Change every sample or bootstrap password. Delete demo users if demo data was loaded.
- Review roles: give each person only the permissions the job needs; use branch scope for branch staff.
- Server: firewall open only for 80/443 and SSH, automatic security updates, SSH keys only.
- `CORS_ORIGINS` lists only the real front-end address(es).
- Two-factor sign-in and per-user permission overrides are not built yet.

## 10. Things that need a decision from the client or their advisers
Tax rates and exemptions (ERCA), prescription and controlled-medicine rules (EFDA), e-invoicing / fiscal-machine integration once the requirements are confirmed, the fiscal calendar, treatment of purchase price differences in the books (accountant).
