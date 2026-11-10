import type { INestApplication } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from './shims/http';

/** A cookie the API set, for the jar (and, when not httpOnly, for document.cookie). */
export interface SetCookie {
  name: string;
  value: string;
  httpOnly: boolean;
  remove: boolean;
  raw: string;
}

/** The demo's cookie jar: the browser ignores Set-Cookie on a service worker's responses. */
export type CookieJar = Map<string, string>;

function parseSetCookie(raw: string): SetCookie {
  const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = decodeURIComponent(pair.slice(eq + 1));
  const lower = attrs.map((a) => a.toLowerCase());
  const expires = lower.find((a) => a.startsWith('expires='));
  const remove =
    lower.includes('max-age=0') || (expires !== undefined && new Date(expires.slice(8)).getTime() < Date.now());
  return { name, value, httpOnly: lower.includes('httponly'), remove, raw };
}

/**
 * Run one fetch Request through the Nest app's Express instance, the way a socket
 * would, and turn what it writes into a fetch Response. The body streams, so the
 * SSE endpoint works too.
 */
export function createDispatcher(app: INestApplication) {
  const express = app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;

  return async function dispatch(
    request: Request,
    jar: CookieJar,
  ): Promise<{ response: Response; cookies: SetCookie[] }> {
    const url = new URL(request.url);
    const req = new IncomingMessage();
    req.method = request.method;
    req.url = url.pathname + url.search;
    request.headers.forEach((v, k) => {
      req.headers[k] = v;
      req.rawHeaders.push(k, v);
    });
    req.headers.host = url.host;
    if (jar.size) {
      req.headers.cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    }
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
    if (body) req.headers['content-length'] = String(body.byteLength);

    const res = new ServerResponse(req);
    const cookies: SetCookie[] = [];

    const response = new Promise<Response>((resolve) => {
      res.once('head', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.getHeaders())) {
          if (k === 'set-cookie') {
            for (const raw of ([] as string[]).concat(v as string | string[])) {
              const c = parseSetCookie(raw);
              cookies.push(c);
              if (c.remove) jar.delete(c.name);
              else jar.set(c.name, c.value);
            }
          } else {
            for (const one of ([] as (string | number)[]).concat(v)) headers.append(k, String(one));
          }
        }
        let sent = 0;
        // The page can drop the response early (navigating away from the SSE stream);
        // after that the stream is closed and must not be written to again.
        let open = true;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const flush = () => {
              while (open && sent < res.chunks.length) controller.enqueue(res.chunks[sent++]);
            };
            res.on('chunk', flush);
            res.once('finish', () => {
              flush();
              if (open) {
                open = false;
                controller.close();
              }
            });
            flush();
          },
          cancel() {
            open = false;
            req.emit('close');
            res.emit('close');
          },
        });
        const nullBody = [101, 204, 205, 304].includes(res.statusCode) || request.method === 'HEAD';
        resolve(new Response(nullBody ? null : stream, { status: res.statusCode, headers }));
      });
    });

    express(req, res);
    if (body) req.push(Buffer.from(body));
    req.push(null);
    return { response: await response, cookies };
  };
}
