// A server-only module the demo never calls (S3, SMTP, the Discord socket, native
// argon2). Importing it is fine; using it throws.
const unavailable = new Proxy(function () {}, {
  get: (_t, p) => (p === '__esModule' ? false : p === 'then' ? undefined : unavailable),
  apply: () => {
    throw new Error('unavailable in the demo');
  },
  construct: () => {
    throw new Error('unavailable in the demo');
  },
});
module.exports = unavailable;
