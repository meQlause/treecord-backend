import { z } from 'zod';

/** campaigns §1 query: every parameter optional; an unknown one is refused. */
export const listCampaignsSchema = z.strictObject({
  status: z.enum(['funding', 'active', 'refunding', 'completed']).optional(),
  species: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
    .optional(),
  region: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListCampaignsQuery = z.infer<typeof listCampaignsSchema>;

/** campaigns §3: no parameters at all. */
export const noQuerySchema = z.strictObject({});

/** `0x` + 40 hex in any case, answered lowercased (campaigns §2). */
export const campaignAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((address) => address.toLowerCase());
