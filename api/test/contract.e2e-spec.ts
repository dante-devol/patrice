import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { AUTHORIZE_META, AuthorizeMeta } from '../src/access/authorize.decorator';
import { PUBLIC_META } from '../src/auth/current-user';
import { CONTRACT_META } from '../src/contract/contract.decorator';
import { ContractRoute, ROUTES } from '../src/contract/routes';
import { BootedApp, bootApp, createEmailCapture, resetDatabase } from './helpers';

interface Handler {
  name: string;
  method: string;
  path: string;
  status: number;
  action?: string;
  isPublic: boolean;
  contract?: ContractRoute;
}

function join(...parts: (string | undefined)[]): string {
  const p = parts.filter((x) => x && x !== '/').join('/');
  return '/' + p.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

/**
 * The contract (src/contract/routes.ts) must describe exactly the routes the app
 * serves: same method, path, success status, gating action and public flag.
 */
describe('Contract registry', () => {
  let booted: BootedApp;
  const handlers: Handler[] = [];

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    const reflector = booted.app.get(Reflector);
    const wrappers = [...booted.app.get(ModulesContainer).values()].flatMap((m) => [
      ...m.controllers.values(),
    ]);
    for (const wrapper of wrappers) {
      const proto = Object.getPrototypeOf(wrapper.instance);
      const base = reflector.get<string>(PATH_METADATA, wrapper.metatype as unknown as new () => unknown);
      const classPublic = reflector.get<boolean>(PUBLIC_META, wrapper.metatype as unknown as new () => unknown) ?? false;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        const sub = reflector.get<string | undefined>(PATH_METADATA, fn);
        if (name === 'constructor' || sub === undefined) continue;
        const reqMethod = reflector.get<RequestMethod>(METHOD_METADATA, fn);
        const method = RequestMethod[reqMethod].toLowerCase();
        const defaultStatus = method === 'post' ? 201 : 200;
        handlers.push({
          name: `${wrapper.name}.${name}`,
          method: method === 'all' ? 'get' : method,
          path: join(base, sub),
          status: reflector.get<number>(HTTP_CODE_METADATA, fn) ?? defaultStatus,
          action: reflector.get<AuthorizeMeta | undefined>(AUTHORIZE_META, fn)?.action,
          isPublic: classPublic || (reflector.get<boolean>(PUBLIC_META, fn) ?? false),
          contract: reflector.get<ContractRoute | undefined>(CONTRACT_META, fn),
        });
      }
    }
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  it('every handler has a contract entry', () => {
    expect(handlers.filter((h) => !h.contract).map((h) => h.name)).toEqual([]);
  });

  it('every contract entry belongs to exactly one handler', () => {
    const used = handlers.map((h) => h.contract).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    const unused = Object.entries(ROUTES).filter(([, r]) => !used.includes(r)).map(([k]) => k);
    expect(unused).toEqual([]);
  });

  it('each entry matches its handler', () => {
    const wrong = handlers
      .filter((h) => h.contract)
      .flatMap((h) => {
        const c = h.contract!;
        const issues: string[] = [];
        if (c.method !== h.method) issues.push(`method ${c.method} != ${h.method}`);
        if (c.path !== h.path) issues.push(`path ${c.path} != ${h.path}`);
        // Redirect handlers send their own 302 through the raw response.
        if (c.kind !== 'redirect' && c.kind !== 'sse' && c.status !== h.status) {
          issues.push(`status ${c.status} != ${h.status}`);
        }
        if (c.action !== h.action) issues.push(`action ${c.action} != ${h.action}`);
        if ((c.public ?? false) !== h.isPublic) issues.push(`public ${c.public} != ${h.isPublic}`);
        return issues.map((i) => `${h.name}: ${i}`);
      });
    expect(wrong).toEqual([]);
  });
});
