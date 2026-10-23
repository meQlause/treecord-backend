import { Router, type RequestHandler } from 'express';
import { pathParam, treeIdParam } from '../../shared/http/params.js';
import type { createTreesService } from './trees.service.js';

type TreesService = ReturnType<typeof createTreesService>;
type Caller = Parameters<TreesService['page']>[1];

/** Public route, mounted under /api/v1 before authentication (trees §1). `signedInIfToken` verifies a token when one
 *  is sent, for the viewer and the exact location. */
export const treesRouter = (trees: TreesService, signedInIfToken: RequestHandler): Router =>
  Router().get('/trees/:treeId', signedInIfToken, async (req, res) => {
    res.json(
      await trees.page(pathParam(treeIdParam, req.params.treeId), res.locals['profile'] as Caller),
    );
  });
