// Regenerates api/openapi.json from the contract (src/contract), then the web client's
// types from it. Cross-platform: sets the env var for the Jest run that writes the file.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const opts = { stdio: 'inherit', shell: true };
const jest = spawnSync('npx jest src/contract/openapi.spec.ts', {
  ...opts,
  env: { ...process.env, UPDATE_OPENAPI: '1' },
});
if (jest.status !== 0) process.exit(jest.status ?? 1);
const web = spawnSync('npm run gen:api', {
  ...opts,
  cwd: fileURLToPath(new URL('../../web/', import.meta.url)),
});
process.exit(web.status ?? 0);
