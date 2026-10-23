import { Router } from 'express';
import { z } from 'zod';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import {
  pageQuerySchema,
  treesQuerySchema,
  uploadsQuerySchema,
  type PageQuery,
  type TreesQuery,
  type UploadsQuery,
} from './planter.schema.js';
import type { createPlanterService } from './planter.service.js';

type PlanterService = ReturnType<typeof createPlanterService>;
type Caller = Parameters<PlanterService['trees']>[0];

const callerOf = (locals: Record<string, unknown>): Caller => locals['profile'] as Caller;

/** Private routes, mounted under /api/v1 behind authentication (planter §1–§4): planters only. */
export const planterRouter = (planter: PlanterService): Router =>
  Router()
    .use('/planter', allowRoles('planter'))
    .get('/planter/trees', validate(treesQuerySchema, 'query'), async (_req, res) => {
      res.json(await planter.trees(callerOf(res.locals), res.locals['query'] as TreesQuery));
    })
    .get('/planter/slots', validate(z.strictObject({}), 'query'), async (_req, res) => {
      res.json(await planter.slots(callerOf(res.locals)));
    })
    .get('/planter/challenges', validate(pageQuerySchema, 'query'), async (_req, res) => {
      res.json(await planter.challenges(callerOf(res.locals), res.locals['query'] as PageQuery));
    })
    .get('/planter/uploads', validate(uploadsQuerySchema, 'query'), async (_req, res) => {
      res.json(await planter.uploads(callerOf(res.locals), res.locals['query'] as UploadsQuery));
    });
