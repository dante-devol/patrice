// Bundle the demo service worker (the real API, compiled by tsc so Nest keeps its
// decorator metadata) for the browser, and copy the WebAssembly and data files it
// loads next to it. Run by make.mjs, after the tsc compile and the snapshot build.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersonas } from './personas.mjs';

const demo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = resolve(demo, '../api');
const buildDir = join(demo, '.build');
const compiled = join(buildDir, 'dist/demo/src');
const client = join(buildDir, 'node_modules/demo-prisma-client');
const snapshot = join(buildDir, 'snapshot/demo-db.tar.gz');
const out = resolve(process.argv[2] ?? join(buildDir, 'worker'));
mkdirSync(out, { recursive: true });
// The switcher's users (scripts/personas.mjs), baked into the worker.
const personas = loadPersonas();
// Identifies this build's database (see sw.ts): changes whenever the snapshot does.
const buildId = process.env.DEMO_BUILD_ID ?? createHash('sha256').update(readFileSync(snapshot)).digest('hex').slice(0, 12);

const unavailable = join(demo, 'src/shims/unavailable.cjs');
const swaps = [
  [/^(node:)?https?$/, join(compiled, 'shims/http.js')],
  [/^(node:)?crypto$/, join(compiled, 'shims/crypto.js')],
  [/^(node:)?net$/, join(compiled, 'shims/net.js')],
  [/^(node:)?perf_hooks$/, join(demo, 'src/shims/perf_hooks.cjs')],
  [/^(node:)?async_hooks$/, join(demo, 'src/shims/async_hooks.cjs')],
  [/^#wasm-engine-loader$/, join(compiled, 'shims/prisma-wasm-loader.js')],
  // The API's `@prisma/client` imports (enums, Prisma helpers) and the demo's client
  // are the same generated client, in its browser (wasm) build.
  [/^(@prisma\/client|demo-prisma-client)$/, join(client, 'wasm.js')],
  // PGlite's ES-module build finds its .wasm/.data next to the worker (import.meta.url).
  [/^@electric-sql\/pglite$/, join(demo, 'node_modules/@electric-sql/pglite/dist/index.js')],
  [/^@cedar-policy\/cedar-wasm\/nodejs$/, join(demo, 'src/shims/cedar.mjs')],
  // Server-only packages the demo composition never calls.
  [/^(argon2|nodemailer|pg-boss|ws|pg)$/, unavailable],
  [/^@aws-sdk\//, unavailable],
];

// Node built-ins served by jspm's browser polyfills.
const BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'events', 'fs', 'os', 'path', 'process', 'querystring', 'stream',
  'string_decoder', 'timers', 'tty', 'url', 'util', 'zlib', 'child_process', 'worker_threads', 'perf_hooks',
  'diagnostics_channel', 'dns', 'tls', 'vm', 'module', 'readline', 'v8', 'punycode', 'constants',
  'repl', 'cluster', 'dgram', 'http2', 'console', 'domain', 'sys', 'wasi',
  'fs/promises', 'stream/promises', 'timers/promises', 'util/types', 'path/posix', 'stream/web',
];
const builtin = new RegExp(`^(node:)?(${BUILTINS.map((b) => b.replace('/', '\\/')).join('|')})$`);

/** Swap Node-only modules for the demo's shims, stand-ins and polyfills. */
const demoSwaps = {
  name: 'demo-swaps',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.namespace === 'builtin') return undefined;
      for (const [re, to] of swaps) if (re.test(args.path)) return { path: to };
      const m = builtin.exec(args.path);
      if (m) return { path: m[2], namespace: 'builtin' };
      return undefined;
    });
    // CommonJS callers want the module itself (`util.inherits(X, require('stream'))`),
    // which is the polyfill's default export, with its named exports alongside.
    b.onLoad({ filter: /.*/, namespace: 'builtin' }, (args) => {
      const target = ['fs/promises', 'stream/promises', 'timers/promises', 'util/types', 'path/posix', 'stream/web'].includes(args.path)
        ? args.path.split('/')[0]
        : args.path;
      return {
        resolveDir: demo,
        loader: 'js',
        contents: `const m = require('@jspm/core/nodelibs/${target}');
const d = m && m.default;
if (d && (typeof d === 'object' || typeof d === 'function')) {
  for (const k of Object.keys(m)) if (k !== 'default' && !(k in d)) { try { d[k] = m[k]; } catch {} }
  module.exports = d;
} else module.exports = m;`,
      };
    });
  },
};

const t0 = Date.now();
const result = await build({
  entryPoints: [join(compiled, 'sw.js')],
  // The API bundle, loaded by the wrapper (demo/sw.js) with importScripts: a classic
  // script, so the worker needs no module-worker support.
  outfile: join(out, 'sw-main.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  conditions: ['worker', 'browser'],
  mainFields: ['browser', 'module', 'main'],
  minify: !process.env.DEMO_DEBUG,
  // Source maps only on request: Firefox DevTools fetches and parses the (17 MB) map
  // when it attaches to the worker, which slows a start with DevTools open.
  sourcemap: !!process.env.DEMO_DEBUG,
  metafile: true,
  logLevel: 'warning',
  // Packages for the API's source come from api/node_modules (one copy, as in Node).
  nodePaths: [join(api, 'node_modules')],
  // Optional Nest integrations: probed with a guarded require, absent here.
  external: [
    '@nestjs/microservices',
    '@nestjs/microservices/*',
    '@nestjs/websockets',
    '@nestjs/websockets/*',
    'class-transformer',
    'class-transformer/*',
    'class-validator',
    '@fastify/*',
  ],
  // A classic script has no import.meta; PGlite finds its files relative to the worker.
  define: { 'import.meta.url': 'self.location.href', __DEMO_BUILD__: JSON.stringify(buildId), __DEMO_PERSONAS__: JSON.stringify(personas), 'process.env.NODE_DEBUG': 'undefined', __filename: '"/sw.js"', __dirname: '"/"' },
  inject: [join(demo, 'src/shims/globals.mjs')],
  plugins: [demoSwaps],
});

const pglite = join(demo, 'node_modules/@electric-sql/pglite/dist');
for (const [from, name] of [
  [join(pglite, 'pglite.wasm')],
  [join(pglite, 'pglite.data')],
  [join(pglite, 'initdb.wasm')],
  [join(pglite, 'citext.tar.gz')],
  [join(client, 'query_engine_bg.wasm')],
  [snapshot],
  [join(api, 'node_modules/@cedar-policy/cedar-wasm/web/cedar_wasm_bg.wasm')],
  [join(demo, 'web/sw.js')],
]) {
  copyFileSync(from, join(out, name ?? from.split(/[\\/]/).pop()));
}

const kb = (f) => Math.round(statSync(join(out, f)).size / 1024);
console.log(`sw-main.js ${kb('sw-main.js')} KB in ${Date.now() - t0} ms -> ${out} (build ${buildId}, ${personas.length} persona(s))`);
const inputs = Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs).find((k) => k.endsWith('sw-main.js'))].inputs);
const byPkg = new Map();
for (const [file, { bytesInOutput }] of inputs) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(file);
  const key = m ? (m[1] === 'demo-prisma-client' ? '(prisma client)' : m[1]) : '(patrice)';
  byPkg.set(key, (byPkg.get(key) ?? 0) + bytesInOutput);
}
console.log(
  [...byPkg].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${k} ${Math.round(v / 1024)} KB`).join('\n'),
);
