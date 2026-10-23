import { Router } from 'express';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import { captureTargetSchema, type CaptureTargetQuery } from './evidence.schema.js';
import type { createEvidenceService } from './evidence.service.js';

type EvidenceService = ReturnType<typeof createEvidenceService>;
type Caller = Parameters<EvidenceService['captureTarget']>[0];

/** Private routes, mounted under /api/v1 behind authentication (evidence §1–§5). */
export const evidenceRouter = (evidence: EvidenceService): Router =>
  Router().get(
    '/evidence/capture-target',
    allowRoles('planter'),
    validate(captureTargetSchema, 'query'),
    async (_req, res) => {
      res.json(
        await evidence.captureTarget(
          res.locals['profile'] as Caller,
          res.locals['query'] as CaptureTargetQuery,
        ),
      );
    },
  );
