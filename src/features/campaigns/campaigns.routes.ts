import { Router, type RequestHandler } from 'express';
import { DomainError } from '../../shared/errors.js';
import { validate } from '../../shared/http/validate.js';
import type { Viewer } from './campaigns.mapper.js';
import {
  campaignAddressSchema,
  listCampaignsSchema,
  noQuerySchema,
  type ListCampaignsQuery,
} from './campaigns.schema.js';
import type { createCampaignsService } from './campaigns.service.js';

type CampaignsService = ReturnType<typeof createCampaignsService>;

/** Public routes, mounted under /api/v1 before authentication (campaigns §1–§3). `signedInIfToken` verifies a token
 *  when one is sent, for the campaign page's viewer figures. */
export const campaignsRouter = (
  campaigns: CampaignsService,
  signedInIfToken: RequestHandler,
): Router =>
  Router()
    .get('/campaigns', validate(listCampaignsSchema, 'query'), async (_req, res) => {
      res.json(await campaigns.list(res.locals['query'] as ListCampaignsQuery));
    })
    .get('/campaigns/:address', signedInIfToken, async (req, res) => {
      const address = campaignAddressSchema.safeParse(req.params.address);

      if (!address.success) {
        throw new DomainError('invalid_path');
      }

      res.json(await campaigns.page(address.data, res.locals['profile'] as Viewer | undefined));
    })
    .get('/species', validate(noQuerySchema, 'query'), async (_req, res) => {
      res.json(await campaigns.species());
    });
