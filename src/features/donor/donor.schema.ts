import { z } from 'zod';
import { pageQuery } from '../../shared/http/cursor.js';

/** donor §2 query: the status tab and the page. */
export const donorCampaignsSchema = z.strictObject({
  status: z.enum(['funding', 'active', 'refunding', 'completed']).optional(),
  ...pageQuery,
});

export type DonorCampaignsQuery = z.infer<typeof donorCampaignsSchema>;

export type CampaignStatus = NonNullable<DonorCampaignsQuery['status']>;
