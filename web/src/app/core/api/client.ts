import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { paths } from './schema';

/**
 * A typed HTTP client over the generated contract (`schema.d.ts`, from the API's
 * OpenAPI document). Paths, path parameters, query, body and response types all come
 * from the contract, so a call that doesn't match the API doesn't compile. The
 * per-area API services are built on it; nothing else writes request or response
 * types by hand.
 */
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Paths that support `M`. */
export type PathWith<M extends Method> = {
  [P in keyof paths]: [NonNullable<paths[P][M]>] extends [never] ? never : P;
}[keyof paths];

type Op<P extends keyof paths, M extends Method> = NonNullable<paths[P][M]>;

type PathParams<O> = O extends { parameters: { path: infer X } } ? ([X] extends [never] ? undefined : X) : undefined;
type QueryParams<O> = O extends { parameters: { query?: infer Q } } ? ([Q] extends [never] ? undefined : Q) : undefined;
type BodyOf<O> = O extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : O extends { requestBody?: { content: { 'application/json': infer B } } }
    ? B | undefined
    : undefined;

type JsonOf<R> = R extends { content: { 'application/json': infer T } } ? T : void;
/** The success response: the 200, 201 or 202 JSON body, or void for 204 and redirects. */
export type ResponseOf<O> = O extends { responses: infer R }
  ? R extends { 200: infer X }
    ? JsonOf<X>
    : R extends { 201: infer X }
      ? JsonOf<X>
      : R extends { 202: infer X }
        ? JsonOf<X>
        : void
  : never;

/** The JSON body a route accepts. */
export type RequestBody<P extends keyof paths, M extends Method> = NonNullable<BodyOf<Op<P, M>>>;
/** The JSON body a route returns. */
export type Response<P extends keyof paths, M extends Method> = ResponseOf<Op<P, M>>;

interface CallOptions<O> {
  path?: PathParams<O>;
  query?: QueryParams<O>;
}

/** Fill `{name}` placeholders and prefix `/api`. */
function url(path: string, params: Record<string, string> | undefined): string {
  const filled = path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params?.[k] ?? ''));
  return `/api${filled}`;
}

function query(q: object | undefined): HttpParams | undefined {
  if (!q) return undefined;
  let params = new HttpParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    params = params.set(k, String(v));
  }
  return params;
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  get<P extends PathWith<'get'>>(path: P, opts: CallOptions<Op<P, 'get'>> = {}): Observable<Response<P, 'get'>> {
    return this.http.get<Response<P, 'get'>>(url(path, opts.path as Record<string, string>), {
      params: query(opts.query as unknown as object),
    });
  }

  post<P extends PathWith<'post'>>(
    path: P,
    body?: RequestBody<P, 'post'> | FormData,
    opts: CallOptions<Op<P, 'post'>> = {},
  ): Observable<Response<P, 'post'>> {
    return this.http.post<Response<P, 'post'>>(url(path, opts.path as Record<string, string>), body ?? {}, {
      params: query(opts.query as unknown as object),
    });
  }

  patch<P extends PathWith<'patch'>>(
    path: P,
    body: RequestBody<P, 'patch'>,
    opts: CallOptions<Op<P, 'patch'>> = {},
  ): Observable<Response<P, 'patch'>> {
    return this.http.patch<Response<P, 'patch'>>(url(path, opts.path as Record<string, string>), body);
  }

  put<P extends PathWith<'put'>>(
    path: P,
    body: RequestBody<P, 'put'>,
    opts: CallOptions<Op<P, 'put'>> = {},
  ): Observable<Response<P, 'put'>> {
    return this.http.put<Response<P, 'put'>>(url(path, opts.path as Record<string, string>), body);
  }

  delete<P extends PathWith<'delete'>>(path: P, opts: CallOptions<Op<P, 'delete'>> = {}): Observable<Response<P, 'delete'>> {
    return this.http.delete<Response<P, 'delete'>>(url(path, opts.path as Record<string, string>), {
      params: query(opts.query as unknown as object),
    });
  }
}
