import { z } from 'zod';

export const forgeConnectionQuerySchema = z.object({ test: z.literal('1').optional() }).strict();
export const forgeConnectionSchema = z.object({
  kind: z.enum(['github', 'gitlab']).nullable(),
  host: z.string().nullable(),
  repository: z.string().nullable(),
  url: z.string().nullable(),
  status: z.enum(['unconfigured', 'untested', 'available', 'unavailable', 'demo']),
  reason: z.string().nullable(),
});
export type ForgeConnection = z.infer<typeof forgeConnectionSchema>;
