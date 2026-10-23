import { Router } from 'express';
import { z } from 'zod';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import { donorCampaignsSchema, type DonorCampaignsQuery } from './donor.schema.js';
import type { createDonorService } from './donor.service.js';

type DonorService = ReturnType<typeof createDonorService>;
type Caller = Parameters<DonorService['dashboard']>[0];

// donor.md: donors and operators, each on their own wallet; planters and auditors are refused
const donorsOnly = allowRoles('donor', 'operator');

/** Private routes, mounted under /api/v1 behind authentication (donor §1–§2). */
export const donorRouter = (donor: DonorService): Router =>
  Router()
    .get(
      '/donor/dashboard',
      donorsOnly,
      validate(z.strictObject({}), 'query'),
      async (_req, res) => {
        res.json(await donor.dashboard(res.locals['profile'] as Caller));
      },
    )
    .get(
      '/donor/campaigns',
      donorsOnly,
      validate(donorCampaignsSchema, 'query'),
      async (_req, res) => {
        res.json(
          await donor.campaigns(
            res.locals['profile'] as Caller,
            res.locals['query'] as DonorCampaignsQuery,
          ),
        );
      },
    );
