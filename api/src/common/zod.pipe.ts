import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodTypeAny, infer as ZodInfer } from 'zod';
import { ValidationError } from './errors';

export interface FieldIssue {
  field: string;
  message: string;
}

/**
 * Validate and narrow a request body/param against a Zod schema at the boundary
 * (overview: "Zod at the boundary"). Failures become 422 with **field-level
 * detail**: `details` is a `{ field, message }[]` the client can render per input,
 * and the top-level message names the specific problem(s) rather than a generic
 * "validation failed".
 */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown, _metadata: ArgumentMetadata): ZodInfer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues: FieldIssue[] = result.error.issues.map((i) => ({
        field: i.path.join('.') || '(body)',
        message: i.message,
      }));
      // De-duplicate messages (e.g. a field with two failing rules) for the summary.
      const unique = [...new Set(issues.map((i) => i.message))];
      const message =
        unique.length === 1 ? unique[0] : unique.join(' ');
      throw new ValidationError(message, issues);
    }
    return result.data;
  }
}
