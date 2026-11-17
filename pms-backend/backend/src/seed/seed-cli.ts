import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { runMigrations } from '../database/migrate';
import { AuditService } from '../modules/audit/audit.service';
import { PasswordService } from '../modules/iam/password.service';
import { SettingsService } from '../modules/platform/settings.service';
import { bootstrapAdmin, seedAccessControl, seedReferenceData } from './seed';

async function main() {
  const env = loadEnv();
  const db = new DatabaseService(env);
  try {
    // Seeding needs the tables to exist, so pending migrations are applied first (a no-op when up to date)
    await runMigrations(db.pool, (m) => console.log(m));
    await seedAccessControl(db.pool);
    await seedReferenceData(db.pool);
    console.log('Permissions, built-in roles, units and dosage forms are up to date.');
    if (env.BOOTSTRAP_ADMIN_USERNAME && env.BOOTSTRAP_ADMIN_PASSWORD) {
      const passwords = new PasswordService(new SettingsService(db, new AuditService(db), env));
      const created = await bootstrapAdmin(db.pool, passwords, env.BOOTSTRAP_ADMIN_USERNAME, env.BOOTSTRAP_ADMIN_PASSWORD);
      console.log(created ? `Created System Administrator "${env.BOOTSTRAP_ADMIN_USERNAME}". The password must be changed at first sign-in.` : 'Users already exist; no administrator was created.');
    } else {
      console.log('BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD not set; skipped administrator creation.');
    }
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
