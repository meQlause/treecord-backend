import { Router } from 'express';
import { z } from 'zod';
import { pageQuery } from '../../shared/http/cursor.js';
import { addressParam, pathParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import type { createCarbonService, PageQuery } from './carbon.service.js';

type CarbonService = ReturnType<typeof createCarbonService>;
type Caller = Parameters<CarbonService['holdings']>[0];

// carbon §2, §5: a positive id of at most 16 digits, no leading zero (FR-238)
const recordId = z.string().regex(/^[1-9]\d{0,15}$/);

// §6: the registry's own retirement id, when there is one
const MAX_REFERENCE = 200;

const registryRetirementSchema = z.strictObject({
  reference: z.string().trim().min(1).max(MAX_REFERENCE).nullable().default(null),
});

const batchesQuerySchema = z.strictObject({ campaign: addressParam.optional(), ...pageQuery });

type BatchesQuery = PageQuery & { campaign?: string };

/** Public routes, mounted under /api/v1 before authentication (carbon §1, §2, §5; a token is ignored). */
export const carbonPublicRouter = (carbon: CarbonService): Router =>
  Router()
    .get('/carbon/batches', validate(batchesQuerySchema, 'query'), async (_req, res) => {
      const { campaign, ...page } = res.locals['query'] as BatchesQuery;

      res.json(await carbon.batches(campaign, page));
    })
    .get('/carbon/batches/:batchId', async (req, res) => {
      res.json(await carbon.batch(pathParam(recordId, req.params.batchId)));
    })
    .get('/carbon/retirements/:retirementId', async (req, res) => {
      res.json(await carbon.certificate(pathParam(recordId, req.params.retirementId)));
    });

/** Private routes, mounted under /api/v1 behind authentication: carbon §3, §4 (always the caller's own wallet) and the
 *  operator's §6. */
export const carbonPrivateRouter = (carbon: CarbonService): Router =>
  Router()
    .get('/carbon/holdings', validate(z.strictObject({}), 'query'), async (_req, res) => {
      res.json(await carbon.holdings(res.locals['profile'] as Caller));
    })
    .get(
      '/carbon/holdings/retirements',
      validate(z.strictObject(pageQuery), 'query'),
      async (_req, res) => {
        res.json(
          await carbon.retirements(
            res.locals['profile'] as Caller,
            res.locals['query'] as PageQuery,
          ),
        );
      },
    )
    .post(
      '/operator/carbon/retirements/:retirementId/registry-retirement',
      allowRoles('operator'),
      validate(registryRetirementSchema),
      async (req, res) => {
        const { reference } = res.locals['body'] as z.infer<typeof registryRetirementSchema>;

        res.json(
          await carbon.markRegistryRetired(pathParam(recordId, req.params.retirementId), reference),
        );
      },
    );
