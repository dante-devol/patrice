import { z } from 'zod';

/** `?from&to` as ISO timestamps; defaults to the last 12 weeks. At most two years. */
export const unitStatsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strip()
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: '`from` must be before `to`' })
  .refine((q) => !q.from || !q.to || q.to.getTime() - q.from.getTime() <= 2 * 366 * 24 * 60 * 60 * 1000, {
    message: 'The range can span at most two years',
  });
export type UnitStatsQueryDto = z.infer<typeof unitStatsQuerySchema>;
