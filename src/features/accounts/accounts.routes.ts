import { Router } from 'express';
import { validate } from '../../shared/http/validate.js';
import { toProfileDto } from './accounts.mapper.js';
import type { ProfileRow } from './accounts.repository.js';
import { updateProfileSchema, type UpdateProfileInput } from './accounts.schema.js';
import type { createAccountsService } from './accounts.service.js';

type AccountsService = ReturnType<typeof createAccountsService>;

/** Private routes, mounted under /api/v1 behind authentication (accounts §1, §2). */
export const accountsRouter = (accounts: AccountsService): Router =>
  Router()
    .get('/me', (_req, res) => {
      // A role switch changes this response, so it is never cached (accounts §1 traps).
      res
        .set('Cache-Control', 'no-store')
        .json({ profile: toProfileDto(res.locals['profile'] as ProfileRow) });
    })
    .post('/profile', validate(updateProfileSchema), async (_req, res) => {
      const profile = await accounts.updateProfile(
        (res.locals['profile'] as ProfileRow).id,
        res.locals['body'] as UpdateProfileInput,
      );

      res.json({ profile: toProfileDto(profile) });
    });
