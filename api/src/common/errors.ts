import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { CodeWithStatus, ErrorCode } from './error-codes';

/**
 * Patrice error envelope: `{ error: { code, message, details? } }`. Every code is in
 * the catalog (error-codes.ts), and each class below accepts only the codes whose
 * catalog status matches its own.
 */
export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

class CodedException extends HttpException {
  constructor(status: HttpStatus, code: ErrorCode, message: string, details?: unknown) {
    super(errorBody(code, message, details), status);
  }
}

export class ValidationError extends CodedException {
  constructor(message = 'Validation failed', details?: unknown) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message, details);
  }
}

/** A 422 carrying a domain-specific code (e.g. NO_DEFAULT_REQUEST_TEMPLATE). */
export class UnprocessableError extends CodedException {
  constructor(code: CodeWithStatus<422> = 'UNPROCESSABLE', message = 'Unprocessable entity', details?: unknown) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }
}

export class DeniedError extends CodedException {
  constructor(code: CodeWithStatus<403> = 'FORBIDDEN', message = 'Forbidden') {
    super(HttpStatus.FORBIDDEN, code, message);
  }
}

export class UnauthenticatedError extends CodedException {
  constructor(code: CodeWithStatus<401> = 'UNAUTHENTICATED', message = 'Authentication required') {
    super(HttpStatus.UNAUTHORIZED, code, message);
  }
}

export class ConflictError extends CodedException {
  constructor(code: CodeWithStatus<409> = 'CONFLICT', message = 'Conflict', details?: unknown) {
    super(HttpStatus.CONFLICT, code, message, details);
  }
}

export class GoneError extends CodedException {
  constructor(code: CodeWithStatus<410> = 'GONE', message = 'No longer available') {
    super(HttpStatus.GONE, code, message);
  }
}

export class NotFoundError extends CodedException {
  constructor(code: CodeWithStatus<404> = 'NOT_FOUND', message = 'Not found') {
    super(HttpStatus.NOT_FOUND, code, message);
  }
}

export class ServiceUnavailableError extends CodedException {
  constructor(code: CodeWithStatus<503> = 'QUEUE_UNAVAILABLE', message = 'Service unavailable') {
    super(HttpStatus.SERVICE_UNAVAILABLE, code, message);
  }
}

// Re-export the Nest base exceptions a couple of call sites use directly.
export {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  UnauthorizedException,
};
