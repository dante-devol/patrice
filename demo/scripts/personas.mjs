// The demo users the header's switcher offers. They come from demo/personas.json, written
// alongside the demo seed:
//
//   [{ "email": "...", "password": "...", "label": "Maya", "description": "Writing lead" }, ...]
//
// (`key` is optional; it defaults to the email.) Until that file exists, the stand-in is
// the seed's admin login, read from api/scripts/seed.mjs. The build bakes the list into
// the worker, which logs in with these through the real login endpoint.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadPersonas() {
  const file = join(demo, 'personas.json');
  if (existsSync(file)) {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list) || list.length === 0) throw new Error('demo/personas.json must be a non-empty array');
    const seen = new Set();
    return list.map((p, i) => {
      for (const field of ['email', 'password', 'label']) {
        if (typeof p[field] !== 'string' || !p[field]) throw new Error(`demo/personas.json[${i}] needs a "${field}"`);
      }
      const key = String(p.key ?? p.email).toLowerCase();
      if (seen.has(key)) throw new Error(`demo/personas.json: "${key}" appears twice`);
      seen.add(key);
      return { key, email: p.email, password: p.password, label: p.label, description: p.description ?? '' };
    });
  }
  const seed = readFileSync(join(demo, '../api/scripts/seed.mjs'), 'utf8');
  const email = /ADMIN_EMAIL = arg\('--email', '([^']+)'\)/.exec(seed)?.[1];
  const password = /PASSWORD = arg\('--password', '([^']+)'\)/.exec(seed)?.[1];
  if (!email || !password) throw new Error('no demo/personas.json, and no admin login in api/scripts/seed.mjs');
  return [{ key: email.toLowerCase(), email, password, label: 'Admin', description: 'Org admin: everything, including Admin' }];
}
