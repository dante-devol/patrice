import { ErrorCode } from '../../common/error-codes';

/**
 * A rule broken inside the domain. Carries a catalog code; the HTTP status comes from
 * the catalog when the exception filter renders it, so the domain never imports
 * transport concerns.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
