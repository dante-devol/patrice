// Test environment defaults. Override DATABASE_URL via the shell to point at a
// different Postgres. Uses the locally-running Postgres 18 + the patrice_test DB.
process.env.DATABASE_URL ||=
  'postgresql://postgres:postgres@localhost:5432/patrice_test?schema=public';
process.env.PUBLIC_BASE_URL ||= 'http://localhost:4200';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789';
process.env.TOKEN_PEPPER ||= 'test-token-pepper-0123456789';
process.env.SMTP_URL ||= 'smtp://localhost:1025';
process.env.EMAIL_FROM ||= 'Patrice Test <test@patrice.local>';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ||= 'error';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = 'false';
// Disable pg-boss in tests — the queue is exercised separately; Slice 1 acceptance
// does not depend on email delivery, and skipping it avoids slow worker startup.
process.env.DISABLE_QUEUE = 'true';
// Throwaway AEAD key so the bot-token cipher is exercised (encrypt-on-connect).
process.env.INTEGRATION_TOKEN_KEY ||=
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
