import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import { openSessionSchema, type OpenSessionInput } from './audit.schema.js';
import type { createAuditService } from './audit.service.js';

type AuditService = ReturnType<typeof createAuditService>;
type Auditor = Parameters<AuditService['open']>[0];

const CREATED = 201;

/** Private routes, mounted under /api/v1 behind authentication (audit §1–§8): auditors only, the role gate first,
 *  even an operator answers 403. */
export const auditRouter = (audit: AuditService): Router =>
  Router()
    .use('/audit/sessions', allowRoles('auditor'))
    .post('/audit/sessions', validate(openSessionSchema), async (_req, res) => {
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
    });
