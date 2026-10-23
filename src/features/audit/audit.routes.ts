import { Router } from 'express';
import { z } from 'zod';
import { pathParam, treeIdParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import {
  challengeSchema,
  closeSchema,
  findingSchema,
  listSessionsSchema,
  openSessionSchema,
  type FindingInput,
  type ListSessionsQuery,
  type OpenSessionInput,
} from './audit.schema.js';
import type { createAuditService } from './audit.service.js';

type AuditService = ReturnType<typeof createAuditService>;
type Auditor = Parameters<AuditService['open']>[0];

const CREATED = 201;
const SESSIONS_PATH = '/audit/sessions';

/** Private routes, mounted under /api/v1 behind authentication (audit §1–§8): auditors only, the role gate first,
 *  even an operator answers 403. */
export const auditRouter = (audit: AuditService): Router =>
  Router()
    .use(SESSIONS_PATH, allowRoles('auditor'))
    .get(SESSIONS_PATH, validate(listSessionsSchema, 'query'), async (_req, res) => {
      res.json(
        await audit.list(
          res.locals['profile'] as Auditor,
          res.locals['query'] as ListSessionsQuery,
        ),
      );
    })
    .post(SESSIONS_PATH, validate(openSessionSchema), async (_req, res) => {
      res
        .status(CREATED)
        .json(
          await audit.open(
            res.locals['profile'] as Auditor,
            res.locals['body'] as OpenSessionInput,
          ),
        );
    })
    .get('/audit/sessions/:id', async (req, res) => {
      res.json(
        await audit.session(res.locals['profile'] as Auditor, pathParam(z.uuid(), req.params.id)),
      );
    })
    .get('/audit/sessions/:id/trees/:treeId', async (req, res) => {
      res.json(
        await audit.tree(
          res.locals['profile'] as Auditor,
          pathParam(z.uuid(), req.params.id),
          pathParam(treeIdParam, req.params.treeId),
        ),
      );
    })
    .post('/audit/sessions/:id/findings', validate(findingSchema), async (req, res) => {
      res.json(
        await audit.record(
          res.locals['profile'] as Auditor,
          pathParam(z.uuid(), req.params.id),
          res.locals['body'] as FindingInput,
        ),
      );
    })
    .post('/audit/sessions/:id/close', async (req, res) => {
      const id = pathParam(z.uuid(), req.params.id);
      // the summary is optional, so is the body
      const { summary } = closeSchema.parse(req.body ?? {});

      res.json(await audit.close(res.locals['profile'] as Auditor, id, summary));
    })
    .get('/audit/sessions/:id/report', async (req, res) => {
      res.json(
        await audit.report(res.locals['profile'] as Auditor, pathParam(z.uuid(), req.params.id)),
      );
    })
    .post('/audit/sessions/:id/challenges', validate(challengeSchema), async (req, res) => {
      const { treeId } = res.locals['body'] as { treeId: string };

      res
        .status(CREATED)
        .json(
          await audit.challenge(
            res.locals['profile'] as Auditor,
            pathParam(z.uuid(), req.params.id),
            treeId,
          ),
        );
    });

/** Public route, mounted under /api/v1 before authentication (audit §9): a token is ignored. */
export const auditPublicRouter = (audit: AuditService): Router =>
  Router().get('/audit/sessions/:id/reproduce', async (req, res) => {
    res.json(await audit.reproduce(pathParam(z.uuid(), req.params.id)));
  });
