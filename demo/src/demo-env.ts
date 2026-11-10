/** The environment the real config validator expects, with demo values. */
export function setDemoEnv(publicBaseUrl: string): void {
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://demo:demo@pglite/demo',
    PUBLIC_BASE_URL: publicBaseUrl,
    SESSION_SECRET: 'demo-session-secret-not-secret',
    TOKEN_PEPPER: 'demo-token-pepper-not-secret',
    SECRETS_KEY: '0'.repeat(64),
    SMTP_URL: 'smtp://demo.invalid:25',
    EMAIL_FROM: 'Patrice demo <demo@patrice.invalid>',
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    COOKIE_SECURE: 'false',
    QUEUE_MODE: 'off',
    INTEGRATION_GATEWAY_ENABLED: 'false',
    PROCESS_ROLE: 'api',
  });
}
