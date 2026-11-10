/**
 * The demo's own endpoints, under `/__demo/`, answered by the service worker before
 * anything reaches the API. The demo header uses them; the API never sees them.
 *
 *   GET /__demo/state   whether the demo is running, and who the real session is for.
 *                       `?peek` answers without starting the API (the start page uses it).
 */
export interface DemoUser {
  id: string;
  email: string | null;
  displayName: string;
}

export interface DemoState {
  started: true;
  running: boolean;
  build: string;
  user: DemoUser | null;
}

export interface DemoContext {
  build: string;
  /** Whether the API is up already (it starts on the first request otherwise). */
  running(): boolean;
  /** Send a request through the API, with the demo's cookie jar, as the page would. */
  api(method: string, path: string, body?: unknown): Promise<Response>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleDemoRequest(request: Request, ctx: DemoContext): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;

  if (route === 'GET /__demo/state') {
    if (url.searchParams.has('peek') && !ctx.running()) {
      return json({ started: true, running: false, build: ctx.build, user: null } satisfies DemoState);
    }
    // Who the session belongs to, as the app itself sees it.
    const me = await ctx.api('GET', '/api/me');
    const user = me.ok ? ((await me.json()) as DemoUser) : null;
    return json({
      started: true,
      running: true,
      build: ctx.build,
      user: user && { id: user.id, email: user.email, displayName: user.displayName },
    } satisfies DemoState);
  }

  return json({ error: { code: 'NOT_FOUND', message: `No demo endpoint ${route}` } }, 404);
}
