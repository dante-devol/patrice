import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';

// Load api/.env into process.env for local runs (Node's built-in loader). In
// Docker the env is supplied by compose and there is no .env file, so the absence
// is expected and ignored.
try {
  (
    process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }
  ).loadEnvFile?.();
} catch {
  // No .env file present — rely on the real environment.
}

async function bootstrap(): Promise<void> {
  const processRole = process.env.PROCESS_ROLE;

  if (processRole === 'worker') {
    const ctx = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
    ctx.enableShutdownHooks();
    new Logger('Bootstrap').log('Patrice worker started');
    return;
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = app.get<Env>(ENV);

  if (env.TRUST_PROXY) {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }
  // Baseline security headers: X-Content-Type-Options: nosniff (matters for the
  // attachment download, which streams a client-supplied content type), frameguard,
  // HSTS (only emitted over HTTPS), and no X-Powered-By. CSP is left off — this tier
  // serves JSON + binary streams, never HTML, so a content policy here is noise; the
  // SPA's CSP belongs to the web tier that serves the document.
  app.use(helmet({ contentSecurityPolicy: false }));
  // SESSION_SECRET enables cookie-parser's signed-cookie verification. Our session/CSRF
  // cookies are opaque, high-entropy, and server-validated (peppered hash lookup), so
  // signing is defence-in-depth rather than the primary control — but the secret is now
  // wired in (previously it was validated on boot yet never consumed).
  app.use(cookieParser(env.SESSION_SECRET));
  // All routes live under /api/* so the web tier's reverse proxy can forward a
  // single prefix (and unknown /api paths return the API's JSON 404 rather than the
  // SPA shell). The SPA itself is served at the origin root by nginx.
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: env.PUBLIC_BASE_URL,
    credentials: true,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`Patrice API listening on :${port} (${env.NODE_ENV})`);
}

void bootstrap();
