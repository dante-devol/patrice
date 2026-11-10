// Build-time half of the browser demo, run in Node: apply the real migrations to a
// PGlite database, serve the demo composition over HTTP, seed it through the API with
// the regular seed script, and (with --snapshot <file>) save the database as a
// tarball the service worker loads. Without --snapshot it just keeps serving.
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error -- subpath export; resolves at runtime and in the bundler
import { citext } from '@electric-sql/pglite/contrib/citext';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDemoApp, setDemoEnv } from './demo-app';
import { migrate } from './migrate';
import { BootstrapService } from '../../src/invitations/bootstrap.service';

const PORT = 3200;
const API_ROOT = path.resolve(__dirname, '../../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: API_ROOT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

async function main(): Promise<void> {
  const snapshot = arg('--snapshot');
  const t0 = Date.now();
  setDemoEnv('http://localhost:4300');
  const db = new PGlite({ extensions: { citext } });
  const dir = path.join(API_ROOT, 'prisma/migrations');
  const names = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort();
  await migrate(db, names.map((n) => [n, fs.readFileSync(path.join(dir, n, 'migration.sql'), 'utf8')]));
  const t1 = Date.now();
  const app = await createDemoApp(db);
  await app.listen(PORT);
  console.log(`demo API on :${PORT} (migrate ${t1 - t0} ms, boot ${Date.now() - t1} ms)`);

  // The worker normally seeds roles and opens bootstrap; there is no worker here.
  // Catch the key it prints so the seed script can claim the first admin.
  let key: string | undefined;
  const log = console.log;
  console.log = (...a: unknown[]) => {
    const m = /BOOTSTRAP KEY: (\S+)/.exec(String(a[0]));
    if (m) key = m[1];
    else log(...a);
  };
  await app.get(BootstrapService).openBootstrap();
  console.log = log;

  if (!snapshot) {
    console.log(`bootstrap key: ${key}`);
    return;
  }
  await run(process.execPath, ['scripts/seed.mjs', '--base', `http://localhost:${PORT}/api`, '--key', key!]);
  await app.close();
  const tar = await db.dumpDataDir('gzip');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, Buffer.from(await tar.arrayBuffer()));
  console.log(`snapshot: ${snapshot} (${Math.round(tar.size / 1024)} KB)`);
  await db.close();
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
