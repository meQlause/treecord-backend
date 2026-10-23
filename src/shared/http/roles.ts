import type { RequestHandler } from 'express';
import { DomainError } from '../errors.js';

/** ADR-008: a route declares its roles; any other role answers 403 forbidden_role (ownership is the service's). */
export const allowRoles =
  (...roles: string[]): RequestHandler =>
  (_req, res, next) => {
    if (!roles.includes((res.locals['profile'] as { role: string }).role)) {
      throw new DomainError('forbidden_role');
    }

    next();
  };
