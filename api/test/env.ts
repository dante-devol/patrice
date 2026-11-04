// Test environment defaults. Override DATABASE_URL via the shell to point at a
// different Postgres. Uses the locally-running Postgres 18 + the patrice_test DB.
process.env.DATABASE_URL ||=
  'postgresql://postgres:postgres@localhost:5432/patrice_test?schema=public';
process.env.PUBLIC_BASE_URL ||= 'http://localhost:4200';
process.env.SESSION_SECRET ||= 'test-session-secret-0123456789';
process.env.TOKEN_PEPPER ||= 'test-token-pepper-0123456789';
process.env.SECRETS_KEY ||= 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
process.env.SMTP_URL ||= 'smtp://localhost:1025';
process.env.EMAIL_FROM ||= 'Patrice Test <test@patrice.local>';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ||= 'error';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = 'false';
// pg-boss runs for real, in sync mode: a publish runs the queue's jobs before it
// returns, and nothing polls or fires on a schedule.
process.env.QUEUE_MODE = 'sync';
// Gateway sessions are tracked but no socket is opened to Discord.
process.env.INTEGRATION_GATEWAY_ENABLED = 'false';
// Throwaway AEAD key so the bot-token cipher is exercised (encrypt-on-connect).
process.env.INTEGRATION_TOKEN_KEY ||=
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
