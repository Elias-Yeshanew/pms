import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(10),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  PERMISSION_CACHE_TTL_MS: z.coerce.number().int().min(0).default(15000),
  SETTINGS_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5000),
  THROTTLE_LOGIN_LIMIT: z.coerce.number().int().positive().default(10),
  UPLOAD_DIR: z.string().default('./uploads'),
  CORS_ORIGINS: z.string().default(''),
  SWAGGER_ENABLED: bool.default('true'),
  JOBS_ENABLED: bool.default('true'),
  /** How many reverse proxies sit in front of the API (0 = none). Needed for correct client IPs in logs and rate limits. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof schema>;
export const ENV = Symbol('ENV');

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}
