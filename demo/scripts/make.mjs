// Build the static browser demo end to end (`npm run build` in demo/), into .build/site:
//  1. check api/ and web/ don't reference the demo;
//  2. patch the PGlite Prisma adapter (uuid[] support);
//  3. generate the demo's Prisma client from a copy of the API's schema;
//  4. compile the demo with the API's source (tsc keeps Nest's decorator metadata);
//  5. build the seeded database snapshot in Node, through the real API;
//  6. bundle the service worker;  7. build the web app;  8. assemble the site.
// Needs `npm ci` in api/ and web/ (the demo uses their packages, not copies).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = resolve(demo, '../api');
const web = resolve(demo, '../web');
const build = join(demo, '.build');
const site = resolve(process.argv[2] ?? join(build, 'site'));
const bin = (dir, name) => join(dir, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);

// The compiled demo and API find packages in the generated client's folder, then in
// api/node_modules: one copy of Nest and Prisma for the API and the demo.
const env = {
  ...process.env,
  NODE_PATH: [join(build, 'node_modules'), join(api, 'node_modules')].join(delimiter),
  // Prisma would otherwise add itself to the nearest package.json (demo/).
  PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
};
const run = (cmd, args, cwd = demo) => {
  console.log(`\n> ${[cmd, ...args].join(' ')}`);
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
};

for (const [dir, name] of [[api, 'api'], [web, 'web'], [demo, 'demo']]) {
  if (!existsSync(join(dir, 'node_modules'))) throw new Error(`Run \`npm ci\` in ${name}/ first.`);
}

// 1.
run(process.execPath, [join(demo, 'scripts/check-isolation.mjs')]);

// 2. pglite-prisma-adapter@0.6 doesn't map Postgres uuid[] (domain_event.recipients).
for (const f of ['index.cjs', 'index.mjs']) {
  const p = join(demo, 'node_modules/pglite-prisma-adapter/dist', f);
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
  console.log(`patched pglite-prisma-adapter ${f}`);
}

// 3. The API's schema with its generator swapped for a Rust-free client that runs on a
// driver adapter (PGlite), generated into .build/node_modules/demo-prisma-client.
// The copy sits in api's tool cache because Prisma must find @prisma/client from it.
const schema = readFileSync(join(api, 'prisma/schema.prisma'), 'utf8');
const generator = /generator client \{[^}]*\}/;
if (!generator.test(schema)) throw new Error('no `generator client` block in api/prisma/schema.prisma');
const clientDir = join(build, 'node_modules/demo-prisma-client');
const cache = join(api, 'node_modules/.cache/patrice-demo');
mkdirSync(cache, { recursive: true });
writeFileSync(
  join(cache, 'schema.prisma'),
  schema.replace(
    generator,
    [
      'generator client {',
      '  provider        = "prisma-client-js"',
      '  previewFeatures = ["queryCompiler", "driverAdapters"]',
      `  output          = "${clientDir.replace(/\\/g, '/')}"`,
      '}',
    ].join('\n'),
  ),
);
rmSync(clientDir, { recursive: true, force: true });
run(bin(api, 'prisma'), ['generate', '--schema', join(cache, 'schema.prisma')]);

// 4.
rmSync(join(build, 'dist'), { recursive: true, force: true });
run(bin(api, 'tsc'), ['-p', join(demo, 'tsconfig.json')]);

// 5–8.
const snapshot = join(build, 'snapshot/demo-db.tar.gz');
run(process.execPath, [join(build, 'dist/demo/src/node-server.js'), '--snapshot', snapshot]);
run(process.execPath, [join(demo, 'scripts/build.mjs'), join(build, 'worker')]);
run(bin(web, 'ng'), ['build'], web);
rmSync(site, { recursive: true, force: true });
run(process.execPath, [join(demo, 'scripts/assemble.mjs'), site]);
console.log(`\nDemo site ready: ${site}\nTry it: npm run serve (http://localhost:4400)`);
