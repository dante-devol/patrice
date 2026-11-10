// Build the static browser demo end to end:
//   node demo/make.mjs [outDir]      (default demo/site)
// 1. patch the PGlite Prisma adapter (uuid[] support), 2. generate Prisma clients,
// 3. compile API + demo with tsc (keeps Nest's decorator metadata), 4. build the seeded
// database snapshot in Node through the real API, 5. bundle the service worker,
// 6. build the web app, 7. assemble the site.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = resolve(here, '..');
const web = resolve(api, '../web');
const site = resolve(process.argv[2] ?? join(here, 'site'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, args, cwd = api) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
};

// 1. pglite-prisma-adapter@0.6 doesn't map Postgres uuid[] (domain_event.recipients).
for (const f of ['index.cjs', 'index.mjs']) {
  const p = join(api, 'node_modules/pglite-prisma-adapter/dist', f);
  let s = readFileSync(p, 'utf8');
  if (s.includes('UUID: 2951')) continue;
  const prefix = f === 'index.cjs' ? 'driverAdapterUtils.' : '';
  s = s.replace('  TIMESTAMPTZ: 1116\n};', '  TIMESTAMPTZ: 1116,\n  UUID: 2951\n};');
  s = s.replace(
    '    case ArrayColumnType.OID:\n',
    `    case ArrayColumnType.UUID:\n      return ${prefix}ColumnTypeEnum.UuidArray;\n    case ArrayColumnType.OID:\n`,
  );
  if (!s.includes('UUID: 2951') || !s.includes('ArrayColumnType.UUID')) throw new Error(`could not patch ${p}`);
  writeFileSync(p, s);
  console.log(`patched ${f}`);
}

// 2–3.
run(npx, ['prisma', 'generate']);
rmSync(join(here, 'dist'), { recursive: true, force: true });
run(npx, ['tsc', '-p', 'demo/tsconfig.json']);
// The compiled demo imports the generated client by relative path.
const link = join(here, 'dist/demo/generated');
if (!existsSync(link)) symlinkSync(join(here, 'generated'), link, 'junction');

// 4–7.
run(process.execPath, ['demo/dist/demo/src/node-server.js', '--snapshot', 'demo/public/demo-db.tar.gz']);
run(process.execPath, ['demo/build.mjs', join(here, 'out')]);
run(npx, ['ng', 'build'], web);
rmSync(site, { recursive: true, force: true });
run(process.execPath, ['demo/assemble.mjs', site]);
console.log(`\nDemo site ready: ${site}\nTry it: node demo/serve.mjs ${site} 4400`);
