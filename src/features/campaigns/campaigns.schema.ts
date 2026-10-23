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

const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);

/** campaigns §4: the S14 step-1 metadata; id, createdAt and the creator are the server's. */
export const metadataSchema = z.strictObject({
  title: z.string().trim().min(3).max(120),
  description: z.string().max(5000).default(''),
  speciesCode: z.string().min(1),
  regionName: z.string().trim().min(2).max(120),
  regionCenter: z.strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
  regionRadiusM: z.number().int().min(100).max(100_000),
  imageUrls: z.array(httpUrl).max(10).default([]),
});

export type MetadataInput = z.infer<typeof metadataSchema>;

/** campaigns §6: how many open slots to claim. */
export const claimSchema = z.strictObject({ count: z.number().int().min(1).max(50) });
