// Vault transit cipher smoke test. Run via: node scripts/smoke-vault.js
// Requires api/.env with VAULT_ADDR, VAULT_TOKEN, and VAULT_TRANSIT_KEY set.
'use strict';

process.loadEnvFile('.env');

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
