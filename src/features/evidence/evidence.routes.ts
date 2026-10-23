import { Router } from 'express';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import { z } from 'zod';
import { pathParam } from '../../shared/http/params.js';
import {
  captureTargetSchema,
  submitSchema,
  uploadUrlSchema,
  type CaptureTargetQuery,
  type SubmitBody,
  type UploadUrlBody,
} from './evidence.schema.js';
import type { createEvidenceService } from './evidence.service.js';

type EvidenceService = ReturnType<typeof createEvidenceService>;
type Caller = Parameters<EvidenceService['captureTarget']>[0];

/** Private routes, mounted under /api/v1 behind authentication (evidence §1–§5). */
export const evidenceRouter = (evidence: EvidenceService): Router =>
  Router()
    .use('/evidence', allowRoles('planter'))
    .get('/evidence/capture-target', validate(captureTargetSchema, 'query'), async (_req, res) => {
      res.json(
        await evidence.captureTarget(
          res.locals['profile'] as Caller,
          res.locals['query'] as CaptureTargetQuery,
        ),
      );
    })
    .post('/evidence/upload-url', validate(uploadUrlSchema), async (_req, res) => {
      const { status, body } = await evidence.uploadUrl(
        res.locals['profile'] as Caller,
        res.locals['body'] as UploadUrlBody,
      );

      res.status(status).json(body);
    })
    .post('/evidence/:submissionId/submit', validate(submitSchema), async (req, res) => {
      const { status, body } = await evidence.submit(
        res.locals['profile'] as Caller,
        pathParam(z.uuid(), req.params.submissionId),
        res.locals['body'] as SubmitBody,
      );

      res.status(status).json(body);
    });
