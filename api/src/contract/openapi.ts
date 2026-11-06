import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z, ZodTypeAny } from 'zod';
import { ERROR_CODES } from '../common/error-codes';
import { SESSION_COOKIE } from '../auth/session.service';
import * as S from './schemas';
import { ContractRoute, ROUTES } from './routes';

/** Unwrap `.refine()` / `.transform()` / `.preprocess()` to the object underneath. */
function objectOf(schema: ZodTypeAny): z.AnyZodObject {
  let s: ZodTypeAny = schema;
  while (s instanceof z.ZodEffects) s = s.innerType();
  if (!(s instanceof z.ZodObject)) throw new Error('Query schemas must be objects');
  return s;
}

function pathParams(path: string): z.AnyZodObject | undefined {
  const names = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (names.length === 0) return undefined;
  return z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
}

function successResponse(route: ContractRoute): RouteConfig['responses'][string] {
  switch (route.kind) {
    case 'json':
      return {
        description: route.summary,
        content: { 'application/json': { schema: route.response ?? z.unknown() } },
      };
    case 'empty':
      return { description: 'No content' };
    case 'redirect':
      return { description: 'Redirect to the web app' };
    case 'binary':
      return {
        description: 'The file',
        content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
      };
    case 'sse':
      return {
        description:
          'Server-sent events: content-free "sync" pings, and "admin-presence" events whose data is an AdminPresenceEvent',
        content: { 'text/event-stream': { schema: z.string() } },
      };
  }
}

/** Build the OpenAPI 3.1 document from the route registry. */
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registry = new OpenAPIRegistry();
  registry.register('ErrorBody', S.ErrorBody);
  // Carried on the SSE stream rather than a JSON route, so it's registered by hand.
  registry.register('AdminPresenceEvent', S.AdminPresenceEvent);
  registry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description:
      'Opaque session cookie. Mutating requests also need the `x-csrf-token` header to match the `patrice_csrf` cookie.',
  });

  for (const [operationId, route] of Object.entries(ROUTES) as [string, ContractRoute][]) {
    const request: RouteConfig['request'] = {};
    const params = pathParams(route.path);
    if (params) request.params = params;
    if (route.query) request.query = objectOf(route.query);
    if (route.body) {
      request.body = { content: { 'application/json': { schema: route.body } } };
    } else if (route.upload) {
      request.body = {
        content: {
          'multipart/form-data': {
            schema: z.object({ file: z.string().openapi({ format: 'binary' }) }),
          },
        },
      };
    }

    registry.registerPath({
      operationId,
      method: route.method,
      path: route.path.replace(/:(\w+)/g, '{$1}'),
      tags: [route.tag],
      summary: route.summary,
      description: route.action ? `Gated by the \`${route.action}\` action.` : undefined,
      security: route.public ? [] : [{ session: [] }],
      request,
      responses: {
        [String(route.status)]: successResponse(route),
        default: {
          description: 'An error; `error.code` is one of `ErrorCode`',
          content: { 'application/json': { schema: S.ErrorBody } },
        },
      },
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Patrice API',
      version: '0.1.0',
      description: `Error codes and their HTTP statuses:\n\n${Object.entries(ERROR_CODES)
        .map(([code, { status, description }]) => `- \`${code}\` (${status}): ${description}`)
        .join('\n')}`,
    },
    servers: [{ url: '/api' }],
  });
}
