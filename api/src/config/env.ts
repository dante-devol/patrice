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
  // Restore window after `retired_at` during which Revive is allowed (and, in
  // Slice 7, GC will not collect). A revive attempt past this window → 409.
  RETIREMENT_GRACE_DAYS: z.coerce.number().int().positive().default(30),

  // Object storage (Slice 4.3). `local` writes blobs to STORAGE_LOCAL_DIR (single
  // instance only — see the slice doc's multi-instance caveat); `s3` uses an
  // S3-compatible store (AWS/MinIO) and serves downloads via pre-signed URLs.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./var/storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: boolFromString.default('false'),
  // Upload cap enforced at the attachment boundary (default 25 MiB).
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),
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
