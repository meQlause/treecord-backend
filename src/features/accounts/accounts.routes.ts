import { Router } from 'express';
import { toProfileDto } from './accounts.mapper.js';
import type { ProfileRow } from './accounts.repository.js';

/** Private routes, mounted under /api/v1 behind authentication (accounts §1). */
export const accountsRouter = (): Router =>
  Router().get('/me', (_req, res) => {
    // A role switch changes this response, so it is never cached (accounts §1 traps).
    res
      .set('Cache-Control', 'no-store')
      .json({ profile: toProfileDto(res.locals['profile'] as ProfileRow) });
  });
