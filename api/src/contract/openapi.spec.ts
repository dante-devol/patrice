import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiDocument } from './openapi';

const FILE = join(__dirname, '..', '..', 'openapi.json');

/**
 * The committed `openapi.json` must match what the code generates, so the web client
 * (generated from that file) can never drift from the API. Regenerate it with
 * `npm run contract:emit`.
 */
describe('OpenAPI contract', () => {
  const generated = JSON.stringify(buildOpenApiDocument(), null, 2) + '\n';

  it('openapi.json is up to date', () => {
    if (process.env.UPDATE_OPENAPI === '1') writeFileSync(FILE, generated);
    expect(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
  });
});
