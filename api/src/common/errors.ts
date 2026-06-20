import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Patrice error envelope: `{ error: { code, message, details? } }` (per overview
 * "Errors" convention). Denials → 403, unauthenticated → 401, validation → 422,
 * optimistic-lock / FCFS loss → 409, consumed/expired invite → 410.
 */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

class CodedException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    super(errorBody(code, message, details), status);
  }
}

export class ValidationError extends CodedException {
  constructor(message = 'Validation failed', details?: unknown) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message, details);
  }
}

/** A 422 carrying a domain-specific code (e.g. NO_DEFAULT_QUESTIONNAIRE). */
export class UnprocessableError extends CodedException {
  constructor(code = 'UNPROCESSABLE', message = 'Unprocessable entity', details?: unknown) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }
}

export class DeniedError extends CodedException {
  constructor(code = 'FORBIDDEN', message = 'Forbidden') {
    super(HttpStatus.FORBIDDEN, code, message);
  }
}

export class UnauthenticatedError extends CodedException {
  constructor(code = 'UNAUTHENTICATED', message = 'Authentication required') {
    super(HttpStatus.UNAUTHORIZED, code, message);
  }
}

export class ConflictError extends CodedException {
  constructor(code = 'CONFLICT', message = 'Conflict') {
    super(HttpStatus.CONFLICT, code, message);
  }
}

export class GoneError extends CodedException {
  constructor(code = 'GONE', message = 'No longer available') {
    super(HttpStatus.GONE, code, message);
  }
}

export class NotFoundError extends CodedException {
  constructor(code = 'NOT_FOUND', message = 'Not found') {
    super(HttpStatus.NOT_FOUND, code, message);
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
