// Vault transit cipher smoke test. Run via: node scripts/smoke-vault.js
// Requires api/.env with VAULT_ADDR=http://127.0.0.1:8200, VAULT_TOKEN=dev-root,
// and VAULT_TRANSIT_KEY=patrice-integration set.
'use strict';

process.loadEnvFile('.env');

if (!process.env.VAULT_ADDR) {
  console.error('Missing VAULT_ADDR in api/.env — set it to http://127.0.0.1:8200 for local dev.');
  process.exit(1);
}

const { VaultTransitAdapter } = require('../dist/integrations/vault-transit.adapter');

const adapter = new VaultTransitAdapter({
  VAULT_ADDR: process.env.VAULT_ADDR,
  VAULT_TOKEN: process.env.VAULT_TOKEN,
  VAULT_TRANSIT_KEY: process.env.VAULT_TRANSIT_KEY,
});

const PLAINTEXT = 'smoke-test-token';

adapter.encrypt(PLAINTEXT)
  .then((ref) => {
    console.log('ref:', ref);
    return adapter.decrypt(ref);
  })
  .then((pt) => {
    console.log('plaintext:', pt);
    if (pt !== PLAINTEXT) {
      console.error('FAIL: round-trip mismatch');
      process.exit(1);
    }
    console.log('OK');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
