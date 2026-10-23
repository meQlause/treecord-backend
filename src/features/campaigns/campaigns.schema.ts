import { z } from 'zod';
import { pageQuery } from '../../shared/http/cursor.js';

/** campaigns §1 query: every parameter optional; an unknown one is refused. */
export const listCampaignsSchema = z.strictObject({
  status: z.enum(['funding', 'active', 'refunding', 'completed']).optional(),
  species: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
    .optional(),
  region: z.string().trim().min(1).max(120).optional(),
  ...pageQuery,
});

export type ListCampaignsQuery = z.infer<typeof listCampaignsSchema>;

/** campaigns §3: no parameters at all. */
export const noQuerySchema = z.strictObject({});
