import { z } from 'zod';
import { multiFacet } from '../tasks/tasks.dto';

const uuid = z.string().uuid();

/**
 * `?from&to` as ISO timestamps (default: the last 12 weeks, at most two years), plus
 * the task list's facets: `team`, `claimant` (seated now) and `requester`, each one id
 * or an `in:`-prefixed comma list.
 */
export const unitStatsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    team: multiFacet(uuid),
    claimant: multiFacet(uuid),
    requester: multiFacet(uuid),
  })
  .strip()
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: '`from` must be before `to`' })
  .refine((q) => !q.from || !q.to || q.to.getTime() - q.from.getTime() <= 2 * 366 * 24 * 60 * 60 * 1000, {
    message: 'The range can span at most two years',
  });
export type UnitStatsQueryDto = z.infer<typeof unitStatsQuerySchema>;
