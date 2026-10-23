import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { addressParam, pathParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { parseIdempotencyKey } from '../jobs/index.js';
import { validate } from '../../shared/http/validate.js';
import type { Viewer } from './campaigns.mapper.js';
import {
  claimSchema,
  listCampaignsSchema,
  metadataSchema,
  noQuerySchema,
  type ListCampaignsQuery,
  type MetadataInput,
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
      res.json(
        await campaigns.page(
          pathParam(addressParam, req.params.address),
          res.locals['profile'] as Viewer | undefined,
        ),
      );
    })
    .get('/species', validate(noQuerySchema, 'query'), async (_req, res) => {
      res.json(await campaigns.species());
    })
    .get('/campaigns/metadata/:id', async (req, res) => {
      res.json(await campaigns.metadata(pathParam(z.uuid(), req.params.id)));
    });

type Caller = Parameters<CampaignsService['claim']>[0];

const CREATED = 201;

/** Private routes, mounted under /api/v1 behind authentication (campaigns §4, §6). */
export const campaignsPrivateRouter = (campaigns: CampaignsService): Router =>
  Router()
    .post(
      '/campaigns/metadata',
      allowRoles('donor', 'operator'),
      validate(metadataSchema),
      async (_req, res) => {
        res
          .status(CREATED)
          .json(
            await campaigns.saveMetadata(
              res.locals['profile'] as Caller,
              res.locals['body'] as MetadataInput,
            ),
          );
      },
    )
    .post('/campaigns/:address/claims', allowRoles('planter'), async (req, res) => {
      // §6 order: the path and the key are checked before the body
      const address = pathParam(addressParam, req.params.address);
      const key = parseIdempotencyKey(req.get('idempotency-key'));
      const { count } = claimSchema.parse(req.body);
      const { status, body } = await campaigns.claim(
        res.locals['profile'] as Caller,
        address,
        count,
        key,
      );

      res.status(status).json(body);
    });
