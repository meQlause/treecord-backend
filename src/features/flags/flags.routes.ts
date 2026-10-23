import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../../shared/http/params.js';
import { allowRoles } from '../../shared/http/roles.js';
import { validate } from '../../shared/http/validate.js';
import type { FlagRow } from './flags.repository.js';
import { raiseFlagSchema, resolveFlagSchema, type RaiseFlagInput } from './flags.schema.js';
import type { createFlagsService } from './flags.service.js';

type FlagsService = ReturnType<typeof createFlagsService>;
type Caller = Parameters<FlagsService['raise']>[0];

const REPLAYED = 200;
const CREATED = 201;

/** flags §1 response: the contributor's own flag; flagger and resolution stay with the operator read. */
const toFlag = (row: FlagRow) => ({
  id: row.id,
  treeId: row.tree_id,
  status: row.status,
  reasonText: row.reason_text,
  reasonHash: row.reason_hash,
  createdAt: row.created_at.toISOString(),
});

/** Private routes, mounted under /api/v1 behind authentication (flags §1, §3). */
export const flagsRouter = (flags: FlagsService): Router =>
  Router()
    .post('/flags', validate(raiseFlagSchema), async (_req, res) => {
      const { flag, idempotent } = await flags.raise(
        res.locals['profile'] as Caller,
        res.locals['body'] as RaiseFlagInput,
      );

      res
        .status(idempotent ? REPLAYED : CREATED)
        .json({ flag: toFlag(flag), ...(idempotent ? { idempotent } : {}) });
    })
    .post('/operator/flags/:id/resolve', allowRoles('operator'), async (req, res) => {
      const id = pathParam(z.uuid(), req.params.id);
      const { status, body } = await flags.resolve(
        res.locals['profile'] as Caller,
        id,
        resolveFlagSchema.parse(req.body),
      );

      res.status(status).json(body);
    });
