import { Pool } from 'pg';
import { loadEnv } from '../config/env';
import { runMigrations } from './migrate';

async function main() {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const applied = await runMigrations(pool, (m) => console.log(m));
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
