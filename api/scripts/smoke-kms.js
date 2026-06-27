// KMS envelope cipher smoke test. Run via: node scripts/smoke-kms.js
// Requires api/.env with KMS_KEY_ID and AWS_REGION set, and .aws/credentials populated.
'use strict';

const path = require('path');

// Point the SDK at the project-local .aws/credentials when running outside Docker.
// Inside Docker the file is mounted at /root/.aws/credentials (the SDK default).
if (!process.env.AWS_SHARED_CREDENTIALS_FILE && !process.env.AWS_ACCESS_KEY_ID) {
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.resolve(__dirname, '../../.aws/credentials');
}

process.loadEnvFile('.env');

const { KmsEnvelopeAdapter } = require('../dist/integrations/kms-envelope.adapter');

const adapter = new KmsEnvelopeAdapter({
  KMS_KEY_ID: process.env.KMS_KEY_ID,
  AWS_REGION: process.env.AWS_REGION,
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
