import { z } from 'zod';

/**
 * Startup configuration. Loaded and validated once on boot; an invalid environment
 * fails the process fast (per Slice 1 "Startup config" — load + validate on boot).
 */
const boolFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PUBLIC_BASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16),
  TOKEN_PEPPER: z.string().min(16),
  SMTP_URL: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  COOKIE_SECURE: boolFromString.default('false'),
  TRUST_PROXY: boolFromString.default('false'),
  ARGON2_MEMORY_COST: z.coerce.number().int().positive().optional(),
  ARGON2_TIME_COST: z.coerce.number().int().positive().optional(),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

/**
 * Parse and validate process.env. Throws a readable aggregate error on failure so
 * the operator sees every missing/invalid key at once.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
