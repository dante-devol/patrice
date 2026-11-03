import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { appendFileSync } from 'node:fs';
import { Observable, map } from 'rxjs';
import { CONTRACT_META } from './contract.decorator';
import { ContractRoute } from './routes';

/**
 * Test-only: validates every response against the route's declared contract, as it
 * will look on the wire. Wired in only under NODE_ENV=test, so the whole e2e suite
 * doubles as a contract test. A mismatch fails the request with a 500. With
 * CONTRACT_REPORT set, mismatches are appended to that file instead, for triage.
 */
@Injectable()
export class ContractCheckInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ContractCheckInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = this.reflector.get<ContractRoute | undefined>(CONTRACT_META, context.getHandler());
    if (!route) throw new Error(`Handler ${context.getHandler().name} has no @Contract`);
    return next.handle().pipe(map((value) => this.check(route, value)));
  }

  private check(route: ContractRoute, value: unknown): unknown {
    let problem: string | null = null;
    if (route.kind === 'json') {
      const wire = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      const result = route.response!.safeParse(wire);
      if (!result.success) problem = JSON.stringify(result.error.issues.slice(0, 5));
    } else if (route.kind === 'empty' && value !== undefined) {
      problem = 'expected no body';
    }
    if (problem) {
      const msg = `Contract mismatch on ${route.method.toUpperCase()} ${route.path}: ${problem}`;
      if (process.env.CONTRACT_REPORT) {
        appendFileSync(process.env.CONTRACT_REPORT, msg + '\n');
      } else {
        this.logger.error(msg);
        throw new Error(msg);
      }
    }
    return value;
  }
}
