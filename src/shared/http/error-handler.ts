import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { isChainUnavailable } from '../chain/client.js';
import { isStorageUnavailable } from '../storage/storage.js';
import { toDomainError } from '../db/constraints.js';
import { isDatabaseUnavailable } from '../db/database.js';
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

type Outcome = { code: ErrorCode; details?: ErrorDetails; log?: true };

// express.json() failures, by the type body-parser sets (be-architecture §5 row 4).
const BODY_ERRORS: Readonly<Record<string, Outcome>> = {
  'entity.parse.failed': { code: 'invalid_json' },
  // phases.md D-6: the registry has no 413; an oversized body is a body that fails its schema
  'entity.too.large': {
    code: 'validation_error',
    details: [{ path: '', message: 'Request body is larger than the JSON limit' }],
  },
};

// The first matcher that recognises the error decides the response (a lookup, conventions §4).
const MATCHERS: ReadonlyArray<(error: unknown) => Outcome | undefined> = [
  (error) =>
    error instanceof DomainError
      ? { code: error.code, ...(error.details && { details: error.details }) }
      : undefined,
  (error) =>
    error instanceof ZodError
      ? {
          code: 'validation_error',
          // an unknown field is named in the path, one entry per field (devices §2: path publicKeyJwk.d)
          details: error.issues.flatMap((issue) =>
            issue.code === 'unrecognized_keys'
              ? issue.keys.map((key) => ({
                  path: [...issue.path, key].join('.'),
                  message: issue.message,
                }))
              : [{ path: issue.path.join('.'), message: issue.message }],
          ),
        }
      : undefined,
  (error) => BODY_ERRORS[String((error as { type?: unknown } | null)?.type)],
  // error-handling §2.1: a constraint violation a service did not translate itself
  (error) => {
    const mapped = toDomainError(error);

    return mapped === undefined
      ? undefined
      : { code: mapped.code, ...(mapped.details && { details: mapped.details }) };
  },
  // ADR-010: a dependency down or timed out
  (error) =>
    isDatabaseUnavailable(error) || isChainUnavailable(error) || isStorageUnavailable(error)
      ? { code: 'service_unavailable', log: true }
      : undefined,
];

/** be-architecture §5 row 10, mounted last: the one place a status is chosen. */
export const errorHandler =
  ({ logUnexpected }: ErrorHandlerOptions): ErrorRequestHandler =>
  (error: unknown, _req, res, _next) => {
    const outcome = MATCHERS.map((match) => match(error)).find((found) => found !== undefined) ?? {
      code: 'internal_error',
      log: true,
    };

    if (outcome.log) {
      logUnexpected(error, res.locals['requestId']);
    }

    send(res, outcome.code, outcome.details);
  };
