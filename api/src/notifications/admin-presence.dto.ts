import { z } from 'zod';
import { ADMIN_PAGES } from './pubsub.port';

export const adminPresenceSchema = z
  .object({ page: z.enum(ADMIN_PAGES), state: z.enum(['editing', 'idle', 'saved']) })
  .strict();

export type AdminPresenceDto = z.infer<typeof adminPresenceSchema>;
