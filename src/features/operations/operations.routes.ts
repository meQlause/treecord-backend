import { Router, type Request, type Response } from 'express';
import { batchIdSchema } from '../../generated/frozen/schemas.js';
import { DomainError } from '../../shared/errors.js';
import { addressParam, pathParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { parseIdempotencyKey } from '../jobs/index.js';
import {
  anchorAssignmentSchema,
  estimateSchema,
  issuanceSchema,
  priceSchema,
} from './operations.schema.js';
import type { createOperationsService } from './operations.service.js';

type OperationsService = ReturnType<typeof createOperationsService>;
type Caller = Parameters<OperationsService['estimate']>[0];

const operatorsOnly = allowRoles('operator');

const keyOf = (req: Request): string | null => parseIdempotencyKey(req.get('idempotency-key'));

const callerOf = (res: Response): Caller => res.locals['profile'] as Caller;

const reply = (res: Response, { status, body }: { status: number; body: object }): void => {
  res.status(status).json(body);
};

/** Private routes, mounted under /api/v1 behind authentication (operations §2–§5): operators only. In each, the path
 *  and the key are checked before the body (README §5, §7). */
export const operationsRouter = (operations: OperationsService): Router =>
  Router()
    .post('/operator/campaigns/:address/anchor-assignments', operatorsOnly, async (req, res) => {
      const address = pathParam(addressParam, req.params.address);
      const key = keyOf(req);

      reply(
        res,
        await operations.assignAnchors(
          callerOf(res),
          address,
          anchorAssignmentSchema.parse(req.body),
          key,
        ),
      );
    })
    .post('/operator/campaigns/:address/estimate', operatorsOnly, async (req, res) => {
      const address = pathParam(addressParam, req.params.address);
      const key = keyOf(req);

      estimateSchema.parse(req.body ?? {});
      reply(res, await operations.estimate(callerOf(res), address, key));
    })
    .post('/operator/campaigns/:address/issuances', operatorsOnly, async (req, res) => {
      const address = pathParam(addressParam, req.params.address);
      // §4: required here only, a duplicate issuance mints twice
      const key = keyOf(req);

      if (key === null) {
        throw new DomainError('invalid_idempotency_key');
      }

      reply(
        res,
        await operations.issue(callerOf(res), address, issuanceSchema.parse(req.body), key),
      );
    })
    .post('/operator/carbon/batches/:batchId/price', operatorsOnly, async (req, res) => {
      const batchId = pathParam(batchIdSchema, req.params.batchId);
      const key = keyOf(req);
      const { usdcPerTonne } = priceSchema.parse(req.body);

      reply(res, await operations.setPrice(callerOf(res), batchId, usdcPerTonne, key));
    });
