import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { errorBody, ErrorBody } from './errors';

/**
 * Normalises every error to the `{ error: { code, message, details? } }` envelope.
 * Our CodedExceptions already carry that shape; Nest's built-ins and unexpected
 * throws are wrapped here so the client always sees one error format.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // CodedException bodies are already the envelope; wrap plain ones.
      const payload: ErrorBody =
        typeof body === 'object' && body !== null && 'error' in body
          ? (body as ErrorBody)
          : errorBody(
              codeForStatus(status),
              typeof body === 'string' ? body : (body as { message?: string }).message ?? 'Error',
            );
      res.status(status).json(payload);
      return;
    }

    // Prisma unique-constraint violations that slip past app-level pre-checks
    // (e.g. a concurrent duplicate) become a clear 409 rather than a generic 500.
    const code = (exception as { code?: string }).code;
    if (code === 'P2002') {
      res
        .status(HttpStatus.CONFLICT)
        .json(errorBody('ALREADY_EXISTS', 'That value is already in use'));
      return;
    }

    this.logger.error('Unhandled exception', exception as Error);
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(errorBody('INTERNAL', 'Internal server error'));
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.GONE:
      return 'GONE';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_FAILED';
    default:
      return 'ERROR';
  }
}
