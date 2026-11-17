import { Pool } from 'pg';
import { PasswordService } from '../modules/iam/password.service';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPINGS, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, DEFAULT_DOSAGE_FORMS, DEFAULT_PAYMENT_METHODS, DEFAULT_ROLES, DEFAULT_UNITS, PERMISSIONS } from './permissions.catalog';

/** Adds missing permissions, built-in roles and role grants. Safe to run repeatedly; never overrides admin changes. */
export async function seedAccessControl(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of PERMISSIONS) {
      const module = p.code.split('.')[0];
      const action = p.code.split('.').slice(1).join('.');
      await client.query(
        `insert into iam.permissions (code, module, action, description) values ($1, $2, $3, $4)
         on conflict (code) do update set description = excluded.description`,
        [p.code, module, action, p.description],
      );
    }
    for (const r of DEFAULT_ROLES) {
      await client.query(
        `insert into iam.roles (name, description, is_system) values ($1, $2, true) on conflict (name) do nothing`,
        [r.name, r.description],
      );
      // A grant is applied only the first time it is seen. If an administrator later removes it, it stays removed.
      const fresh = await client.query(
        `insert into platform.seed_grants (role_name, permission_code)
         select $1, c from unnest($2::text[]) c on conflict do nothing returning permission_code`,
        [r.name, r.permissions],
      );
      if (fresh.rowCount) {
        await client.query(
          `insert into iam.role_permissions (role_id, permission_id)
           select ro.id, pe.id from iam.roles ro, iam.permissions pe
            where ro.name = $1 and pe.code = any($2::text[]) on conflict do nothing`,
          [r.name, fresh.rows.map((x) => x.permission_code)],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Default pharmacy units and dosage forms. Existing rows are left untouched. */
export async function seedReferenceData(pool: Pool): Promise<void> {
  for (const [code, name] of DEFAULT_UNITS) {
    await pool.query(`insert into catalog.units (code, name) values ($1, $2) on conflict (code) do nothing`, [code, name]);
  }
  for (const name of DEFAULT_DOSAGE_FORMS) {
    await pool.query(`insert into catalog.dosage_forms (name) values ($1) on conflict (name) do nothing`, [name]);
  }
  for (const m of DEFAULT_PAYMENT_METHODS) {
    await pool.query(`insert into sales.payment_methods (code, name, is_cash, is_credit, requires_reference, sort_order) values ($1, $2, $3, $4, $5, $6) on conflict (code) do nothing`, [m.code, m.name, m.isCash, m.isCredit, m.requiresReference, m.sort]);
  }
  for (const a of DEFAULT_ACCOUNTS) {
    await pool.query(`insert into finance.accounts (code, name, type, is_system) values ($1, $2, $3, $4) on conflict (code) do nothing`, [a.code, a.name, a.type, a.system]);
  }
  for (const m of DEFAULT_ACCOUNT_MAPPINGS) {
    await pool.query(`insert into finance.account_mappings (key, account_id, description) select $1, id, $3 from finance.accounts where code = $2 on conflict (key) do nothing`, [m.key, m.code, m.description]);
  }
  for (const c of DEFAULT_EXPENSE_CATEGORIES) {
    await pool.query(`insert into finance.expense_categories (code, name, account_id) select $1, $2, id from finance.accounts where code = $3 on conflict (code) do nothing`, [c.code, c.name, c.account]);
  }
  for (const c of DEFAULT_INCOME_CATEGORIES) {
    await pool.query(`insert into finance.income_categories (code, name, account_id) select $1, $2, id from finance.accounts where code = $3 on conflict (code) do nothing`, [c.code, c.name, c.account]);
  }
}

/** Creates the first System Administrator if no user exists yet. Returns true when one was created. */
export async function bootstrapAdmin(pool: Pool, passwords: PasswordService, username: string, password: string): Promise<boolean> {
  const existing = await pool.query(`select 1 from iam.users limit 1`);
  if (existing.rowCount) return false;
  await passwords.assertPolicy(password, username);
  const hash = await passwords.hash(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `insert into iam.users (username, password_hash, must_change_password, password_changed_at) values ($1, $2, true, now()) returning id`,
      [username, hash],
    );
    await client.query(
      `insert into iam.user_roles (user_id, role_id, branch_id) select $1, id, null from iam.roles where name = 'System Administrator'`,
      [u.rows[0].id],
    );
    await client.query(
      `insert into audit.audit_logs (action, entity_type, entity_id, new_value) values ('user.bootstrap_admin_created', 'user', $1, $2)`,
      [u.rows[0].id, JSON.stringify({ username })],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
