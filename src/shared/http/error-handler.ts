import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { DomainError, ERROR_REGISTRY, type ErrorCode, type ErrorDetails } from '../errors.js';

const PLACEHOLDER = /\{(\w+)\}/g;

// Fills {name} from details; a placeholder with no value stays for the screen to fill (error-handling §4).
const fill = (template: string, details: ErrorDetails | undefined): string =>
  template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value =
      details !== undefined && !Array.isArray(details)
        ? (details as Record<string, unknown>)[name]
        : undefined;

    return value === undefined ? placeholder : String(value);
  });

const send = (res: Response, code: ErrorCode, details?: ErrorDetails): void => {
  const { status, message } = ERROR_REGISTRY[code];

  res.status(status).json({
    error: {
      code,
      message: fill(message, details),
      ...(details === undefined ? {} : { details }),
      requestId: res.locals['requestId'],
    },
  });
};

/** be-architecture §5 row 9: an unknown path answers the not_found envelope, never Express's HTML. */
export const notFound: RequestHandler = (_req, res) => {
  send(res, 'not_found');
};

type ErrorHandlerOptions = {
  /** NFR-055: the full error is logged with the request id; the response carries neither. */
  logUnexpected: (error: unknown, requestId: string) => void;
};

/** be-architecture §5 row 10, mounted last: the one place a status is chosen. */
export const errorHandler =
  ({ logUnexpected }: ErrorHandlerOptions): ErrorRequestHandler =>
  (error: unknown, _req, res, _next) => {
    if (error instanceof DomainError) {
      send(res, error.code, error.details);

      return;
    }

    if (error instanceof ZodError) {
      send(
        res,
        'validation_error',
        error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );

      return;
    }

    logUnexpected(error, res.locals['requestId']);
    send(res, 'internal_error');
  };
