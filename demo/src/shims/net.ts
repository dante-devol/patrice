/** `node:net` for the browser demo: just the address helpers (proxy-addr uses them). */
const v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
export function isIPv4(s: string): boolean {
  return v4.test(s);
}
export function isIPv6(s: string): boolean {
  return s.includes(':');
}
export function isIP(s: string): number {
  return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0;
}
export class Socket {}
export default { isIP, isIPv4, isIPv6, Socket };
