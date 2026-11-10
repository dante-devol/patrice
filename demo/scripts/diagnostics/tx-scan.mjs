// Diagnostics: list code inside `$transaction(async (tx) => { ... })` callbacks that
// talks to the database outside the transaction — `this.prisma.*`, or a call to another
// service's method that isn't handed `tx`. On Postgres that's a second connection; on
// PGlite (one connection) it waits for the open transaction: a deadlock.
//   node scripts/diagnostics/tx-scan.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../api/src/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
  }
})(root);

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const re = /\$transaction\(\s*async\s*\(\s*(\w+)\s*\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const tx = m[1];
    // Find the callback body by brace matching.
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const body = src.slice(re.lastIndex, i);
    const startLine = src.slice(0, re.lastIndex).split('\n').length;
    body.split('\n').forEach((line, k) => {
      const code = line.replace(/\/\/.*$/, '');
      const direct = /this\.prisma\./.test(code);
      // `await this.someService.method(...)` with no tx argument.
      const call = /await\s+this\.(\w+)\.(\w+)\(([^)]*)/.exec(code);
      const viaService = call && call[1] !== 'prisma' && !new RegExp(`\\b${tx}\\b`).test(code);
      if (direct || viaService) {
        console.log(`${file.slice(root.length)}:${startLine + k}  ${code.trim().slice(0, 110)}`);
      }
    });
  }
}
