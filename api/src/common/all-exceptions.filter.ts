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
import { codeForStatus, ERROR_CODES, ErrorCode } from './error-codes';
import { DomainError } from '../domain/shared/domain-error';

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

    if (exception instanceof DomainError) {
      res
        .status(ERROR_CODES[exception.code].status)
        .json(errorBody(exception.code, exception.message, exception.details));
      return;
    }

    // Prisma constraint errors that slip past app-level pre-checks (usually a race
    // with a concurrent write) become clear 4xx responses rather than a generic 500.
    const prismaError = PRISMA_ERRORS[(exception as { code?: string }).code ?? ''];
    if (prismaError) {
      res.status(prismaError.status).json(errorBody(prismaError.code, prismaError.message));
      return;
    }

    this.logger.error('Unhandled exception', exception as Error);
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(errorBody('INTERNAL', 'Internal server error'));
  }
}

const PRISMA_ERRORS: Record<string, { status: number; code: ErrorCode; message: string }> = {
  // Unique constraint.
  P2002: { status: HttpStatus.CONFLICT, code: 'ALREADY_EXISTS', message: 'That value is already in use' },
  // Foreign-key constraint: a referenced row is gone, or a RESTRICT referrer remains.
  P2003: {
    status: HttpStatus.CONFLICT,
    code: 'REFERENCE_CONFLICT',
    message: 'Another record still references this one, or a referenced record is gone',
  },
  // Required record missing (e.g. an update/delete raced a delete).
  P2025: { status: HttpStatus.NOT_FOUND, code: 'RECORD_NOT_FOUND', message: 'Record not found' },
};
