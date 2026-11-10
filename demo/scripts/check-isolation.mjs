// The demo is strictly outside the product: nothing in api/ or web/ may reference it.
// Fails (exit 1) on any of the hooks the demo uses, found in api/ or web/ source:
// imports from the demo project, the `patriceDemo` global, `/__demo/` endpoints, or
// the demo's generated Prisma client. Runs at the start of every demo build.
//   node scripts/check-isolation.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['node_modules', 'dist', '.angular', 'coverage', '.cache', '.wrangler']);
const EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.html', '.json', '.prisma', '.css', '.scss']);
const HOOKS = [
  [/\bpatriceDemo\b/, 'the demo global (patriceDemo)'],
  [/\/__demo\b/, 'a demo endpoint (/__demo)'],
  [/demo-prisma-client/, "the demo's Prisma client"],
  [/(?:from\s+|require\(\s*|import\(\s*)['"][^'"]*(?:^|\/)demo\/[^'"]*['"]/, 'an import from the demo project'],
];

const problems = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXT.has(extname(name))) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const [re, what] of HOOKS) {
            if (re.test(line)) problems.push(`${relative(root, p)}:${i + 1}  ${what}: ${line.trim().slice(0, 100)}`);
          }
        });
    }
  }
}
for (const part of ['api', 'web']) walk(join(root, part));

if (problems.length) {
  console.error(`The demo must stay outside api/ and web/, but they reference it:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('isolation: api/ and web/ have no references to the demo');
