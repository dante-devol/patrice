// Node globals for the browser demo (esbuild `inject`): `process` and `Buffer`.
import processModule from '@jspm/core/nodelibs/process';
import { Buffer } from '@jspm/core/nodelibs/buffer';

const process = processModule;
process.env ??= {};

// The polyfilled Buffer predates the `base64url` encoding, which Patrice's tokens use.
// Teach it the encoding (it's base64 with a URL-safe alphabet and no padding).
if (!Buffer.isEncoding('base64url')) {
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (enc, start, end) {
    if (String(enc).toLowerCase() !== 'base64url') return toString.call(this, enc, start, end);
    return toString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const from = Buffer.from;
  Buffer.from = function (value, enc, length) {
    if (typeof value === 'string' && String(enc).toLowerCase() === 'base64url') {
      return from.call(this, value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    }
    return from.call(this, value, enc, length);
  };
  const byteLength = Buffer.byteLength;
  Buffer.byteLength = function (value, enc) {
    return String(enc).toLowerCase() === 'base64url' ? Buffer.from(value, 'base64url').length : byteLength.call(this, value, enc);
  };
  const isEncoding = Buffer.isEncoding;
  Buffer.isEncoding = (enc) => String(enc).toLowerCase() === 'base64url' || isEncoding(enc);
}

// Prisma's runtime checks `x instanceof SharedArrayBuffer`; browsers only define it on
// cross-origin-isolated pages. A stand-in nothing is an instance of keeps that false.
globalThis.SharedArrayBuffer ??= class SharedArrayBuffer {};

export { process, Buffer };
