import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { runMigrations } from './database/migrate';
import { DatabaseService } from './database/database.service';
import { ENV, Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  configureApp(app);
  app.enableShutdownHooks();
  const env = app.get<Env>(ENV);
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  // Migrations are applied before the app accepts traffic; a failed migration stops startup.
  await runMigrations(app.get(DatabaseService).pool, (m) => new Logger('Migrations').log(m));
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API listening on port ${env.PORT} (${env.NODE_ENV})`);
}
bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
