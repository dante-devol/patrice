/**
 * The slice of Node's `http` module that Express and Nest touch, for the browser
 * demo. There is no socket: the dispatcher builds an IncomingMessage from a fetch
 * Request and collects what Express writes into a ServerResponse. This emulates
 * Node, not Patrice, so it doesn't change when the app does.
 */
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

export const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
export const STATUS_CODES: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found',
  303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request',
  401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
};

export class FakeSocket extends EventEmitter {
  remoteAddress = '127.0.0.1';
  remotePort = 0;
  encrypted = false;
  readable = true;
  writable = true;
  destroyed = false;
  setTimeout(): this { return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  destroy(): this { this.destroyed = true; return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
}

export class IncomingMessage extends Readable {
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  trailers = {};
  method = 'GET';
  url = '/';
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  socket: FakeSocket;
  connection: FakeSocket;
  constructor(socket?: FakeSocket) {
    super();
    this.socket = this.connection = socket ?? new FakeSocket();
  }
  _read(): void {}
  setTimeout(): this { return this; }
}

export class OutgoingMessage extends Writable {}

export class ServerResponse extends Writable {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  finished = false;
  sendDate = false;
  chunkedEncoding = false;
  readonly chunks: Uint8Array[] = [];
  private readonly headerMap = new Map<string, { name: string; value: number | string | string[] }>();
  req: IncomingMessage;
  socket: FakeSocket;
  connection: FakeSocket;
  constructor(req: IncomingMessage) {
    super();
    this.req = req;
    this.socket = this.connection = req.socket;
    this.on('finish', () => { this.finished = true; });
  }
  setHeader(name: string, value: number | string | string[]): this {
    this.headerMap.set(name.toLowerCase(), { name, value });
    return this;
  }
  appendHeader(name: string, value: string | string[]): this {
    const cur = this.getHeader(name);
    const add = Array.isArray(value) ? value : [value];
    return this.setHeader(name, cur === undefined ? add : [...(Array.isArray(cur) ? cur : [String(cur)]), ...add]);
  }
  getHeader(name: string) { return this.headerMap.get(name.toLowerCase())?.value; }
  getHeaders(): Record<string, number | string | string[]> {
    const o: Record<string, number | string | string[]> = {};
    for (const [k, v] of this.headerMap) o[k] = v.value;
    return o;
  }
  getHeaderNames(): string[] { return [...this.headerMap.keys()]; }
  hasHeader(name: string): boolean { return this.headerMap.has(name.toLowerCase()); }
  removeHeader(name: string): void { this.headerMap.delete(name.toLowerCase()); }
  writeHead(code: number, msg?: unknown, headers?: unknown): this {
    this.statusCode = code;
    if (typeof msg === 'string') this.statusMessage = msg;
    else headers = msg;
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, string>)) this.setHeader(k, v);
    }
    this.headersSent = true;
    this.emit('head');
    return this;
  }
  flushHeaders(): void { this.headersSent = true; this.emit('head'); }
  setTimeout(): this { return this; }
  writeContinue(): void {}
  _write(chunk: unknown, encoding: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!this.headersSent) { this.headersSent = true; this.emit('head'); }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : (chunk as Uint8Array);
    this.chunks.push(bytes);
    // Streamed responses (SSE) are read as they're written.
    this.emit('chunk', bytes);
    cb();
  }
  end(...args: unknown[]): this {
    if (!this.headersSent) { this.headersSent = true; this.emit('head'); }
    return (Writable.prototype.end as (...a: unknown[]) => this).apply(this, args);
  }
}

class FakeServer extends EventEmitter {
  listening = false;
  constructor(readonly handler?: unknown) { super(); }
  listen(...args: unknown[]): this {
    this.listening = true;
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
    queueMicrotask(() => { this.emit('listening'); cb?.(); });
    return this;
  }
  close(cb?: () => void): this { this.listening = false; queueMicrotask(() => cb?.()); return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
  setTimeout(): this { return this; }
}

export function createServer(...args: unknown[]): FakeServer {
  return new FakeServer(args.find((a) => typeof a === 'function'));
}
export class Agent {}
export const globalAgent = new Agent();
export function request(): never { throw new Error('http.request is unavailable in the demo'); }
export function get(): never { throw new Error('http.get is unavailable in the demo'); }
export const Server = FakeServer;

export default {
  METHODS, STATUS_CODES, IncomingMessage, OutgoingMessage, ServerResponse, createServer, Agent, globalAgent, request, get, Server,
};
