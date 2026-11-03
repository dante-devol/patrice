import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The answer validator is shared with the web client, so a form is checked by the
 * same rules the API applies on submit. The source of truth lives here; the web keeps
 * a generated copy, which must match. Regenerate it with `npm run contract:emit`.
 */
const FILES = ['request-template.types.ts', 'validate-submission.ts'];
const WEB_DIR = join(__dirname, '..', '..', '..', 'web', 'src', 'app', 'core', 'validation');
const HEADER =
  '// GENERATED from api/src/request-templates by `npm run contract:emit`. Do not edit.\n';

describe('shared answer validator', () => {
  it.each(FILES)('the web copy of %s is up to date', (file) => {
    const expected = HEADER + readFileSync(join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
    const target = join(WEB_DIR, file);
    if (process.env.UPDATE_OPENAPI === '1') {
      mkdirSync(WEB_DIR, { recursive: true });
      writeFileSync(target, expected);
    }
    expect(readFileSync(target, 'utf8').replace(/\r\n/g, '\n')).toBe(expected);
  });
});
