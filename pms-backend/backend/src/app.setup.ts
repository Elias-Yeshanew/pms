import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { ENV, Env } from './config/env';

/** Shared by main.ts and the test harness so tests exercise the real configuration. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  app.use(helmet());
  app.setGlobalPrefix('api/v1', { exclude: [] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: false });
  if (env.NODE_ENV !== 'production' || env.SWAGGER_ENABLED) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Pharmacy Management System API').setVersion('0.1').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }

  const clientDir = fs.existsSync(path.resolve(__dirname, '..', 'client'))
    ? path.resolve(__dirname, '..', 'client')
    : path.resolve(process.cwd(), 'client');

  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.use((req: any, res: any, next: any) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        return res.sendFile(path.join(clientDir, 'index.html'));
      }
      next();
    });
  }
}
