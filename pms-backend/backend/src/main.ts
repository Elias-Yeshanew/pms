import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { runMigrations } from './database/migrate';
import { DatabaseService } from './database/database.service';
import { ENV, Env } from './config/env';
import { bootstrapAdmin, seedAccessControl, seedReferenceData } from './seed/seed';
import { PasswordService } from './modules/iam/password.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  configureApp(app);
  app.enableShutdownHooks();
  const env = app.get<Env>(ENV);
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  // Migrations are applied before the app accepts traffic; a failed migration stops startup.
  const db = app.get(DatabaseService);
  await runMigrations(db.pool, (m) => new Logger('Migrations').log(m));
  await seedAccessControl(db.pool);
  await seedReferenceData(db.pool);
  if (env.BOOTSTRAP_ADMIN_USERNAME && env.BOOTSTRAP_ADMIN_PASSWORD) {
    const passwords = app.get(PasswordService);
    const created = await bootstrapAdmin(db.pool, passwords, env.BOOTSTRAP_ADMIN_USERNAME, env.BOOTSTRAP_ADMIN_PASSWORD);
    if (created) {
      new Logger('Bootstrap').log(`Created initial System Administrator "${env.BOOTSTRAP_ADMIN_USERNAME}"`);
    }
  }
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API listening on port ${env.PORT} (${env.NODE_ENV})`);
}
bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
