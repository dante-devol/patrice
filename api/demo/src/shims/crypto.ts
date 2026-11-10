/**
 * `node:crypto` for the browser demo: the jspm polyfill (crypto-browserify), plus the
 * few functions it lacks that Patrice calls.
 */
// @ts-expect-error -- untyped polyfill
import * as base from '@jspm/core/nodelibs/crypto';
// @ts-expect-error -- untyped polyfill
export * from '@jspm/core/nodelibs/crypto';

type Hmac = { update(d: Uint8Array): Hmac; digest(): Uint8Array };
const poly = base as unknown as { createHmac(alg: string, key: Uint8Array): Hmac };

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

const bytes = (v: string | Uint8Array): Buffer => (typeof v === 'string' ? Buffer.from(v) : Buffer.from(v));

/** RFC 5869 HKDF over the polyfill's HMAC. */
export function hkdfSync(
  digest: string,
  ikm: string | Uint8Array,
  salt: string | Uint8Array,
  info: string | Uint8Array,
  keylen: number,
): ArrayBuffer {
  const prk = poly.createHmac(digest, bytes(salt)).update(bytes(ikm)).digest();
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let len = 0;
  for (let i = 1; len < keylen; i++) {
    prev = Buffer.from(poly.createHmac(digest, prk).update(Buffer.concat([prev, bytes(info), Buffer.from([i])])).digest());
    out.push(prev);
    len += prev.length;
  }
  const r = Buffer.concat(out).subarray(0, keylen);
  return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) as ArrayBuffer;
}

export default { ...(base as object), timingSafeEqual, randomUUID, hkdfSync };
