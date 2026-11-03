import { ArgumentsHost, HttpException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConflictError } from './errors';

function run(exception: unknown): { status: number; body: unknown } {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(s: number) {
      out.status = s;
      return this;
    },
    json(b: unknown) {
      out.body = b;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return out;
}

describe('AllExceptionsFilter', () => {
  it('passes coded errors through unchanged', () => {
    const r = run(new ConflictError('LAST_ADMIN', 'nope'));
    expect(r).toEqual({ status: 409, body: { error: { code: 'LAST_ADMIN', message: 'nope' } } });
  });

  it.each([
    ['P2002', 409, 'ALREADY_EXISTS'],
    ['P2003', 409, 'REFERENCE_CONFLICT'],
    ['P2025', 404, 'RECORD_NOT_FOUND'],
  ])('maps Prisma %s to %i %s', (code, status, errorCode) => {
    const r = run(Object.assign(new Error('prisma'), { code }));
    expect(r.status).toBe(status);
    expect((r.body as { error: { code: string } }).error.code).toBe(errorCode);
  });

  it('gives Nest built-ins a catalog code for their status', () => {
    const r = run(new HttpException('slow down', 429));
    expect(r).toEqual({ status: 429, body: { error: { code: 'TOO_MANY_REQUESTS', message: 'slow down' } } });
  });

  it('hides unexpected errors behind INTERNAL', () => {
    const r = run(new Error('boom'));
    expect(r.status).toBe(500);
    expect((r.body as { error: { code: string } }).error.code).toBe('INTERNAL');
  });
});
