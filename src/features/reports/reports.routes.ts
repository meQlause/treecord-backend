import { Router } from 'express';
import { z } from 'zod';
import { pageQuery } from '../../shared/http/cursor.js';
import { addressParam, pathParam } from '../../shared/http/params.js';
import { validate } from '../../shared/http/validate.js';
import type { createReportsService, EvidenceQuery } from './reports.service.js';

type ReportsService = ReturnType<typeof createReportsService>;

// reports §2: only the page parameters
const evidenceQuerySchema = z.strictObject(pageQuery);

/** Public routes, mounted under /api/v1 before authentication (reports §1–§2). */
export const reportsRouter = (reports: ReportsService): Router =>
  Router()
    .get('/reports/campaign/:address', async (req, res) => {
      res.json(await reports.report(pathParam(addressParam, req.params.address)));
    })
    .get(
      '/reports/campaign/:address/evidence',
      validate(evidenceQuerySchema, 'query'),
      async (req, res) => {
        res.json(
          await reports.evidence(
            pathParam(addressParam, req.params.address),
            res.locals['query'] as EvidenceQuery,
          ),
        );
      },
    );
