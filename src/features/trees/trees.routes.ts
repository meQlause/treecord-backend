import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError } from '../../shared/errors.js';
import type { createTreesService } from './trees.service.js';

type TreesService = ReturnType<typeof createTreesService>;
type Caller = Parameters<TreesService['page']>[1];

const MAX_TREE_ID = 9_223_372_036_854_775_807n;

// trees §1: a positive decimal within bigint range, kept a string (REG-001). One check, so BigInt never sees a
// string the pattern refused (zod runs every check, even after one fails).
const treeIdSchema = z
  .string()
  .refine((treeId) => /^[1-9]\d{0,18}$/.test(treeId) && BigInt(treeId) <= MAX_TREE_ID);

/** Public route, mounted under /api/v1 before authentication (trees §1). `signedInIfToken` verifies a token when one
 *  is sent, for the viewer and the exact location. */
export const treesRouter = (trees: TreesService, signedInIfToken: RequestHandler): Router =>
  Router().get('/trees/:treeId', signedInIfToken, async (req, res) => {
    const treeId = treeIdSchema.safeParse(req.params.treeId);

    if (!treeId.success) {
      throw new DomainError('invalid_path');
    }

    res.json(await trees.page(treeId.data, res.locals['profile'] as Caller));
  });
