import { HttpErrorResponse } from '@angular/common/http';

interface FieldIssue {
  field: string;
  message: string;
}

interface ErrorEnvelope {
  error?: { message?: string; details?: unknown };
}

/**
 * Pull a specific, human message out of the Patrice error envelope. When the API
 * returns field-level validation `details` (`{ field, message }[]`), each distinct
 * message is surfaced (one per line) so the user sees exactly what to fix —
 * not a generic "validation failed".
 */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as ErrorEnvelope | undefined;
    const details = body?.error?.details;
    if (Array.isArray(details) && details.length > 0) {
      const messages = (details as FieldIssue[])
        .map((d) => d?.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0);
      const unique = [...new Set(messages)];
      if (unique.length > 0) return unique.join('\n');
    }
    return body?.error?.message ?? err.message ?? 'Request failed';
  }
  return (err as Error)?.message ?? 'Unexpected error';
}
