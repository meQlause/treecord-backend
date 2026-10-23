import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

/** Route edge (conventions: strict schemas, services trust their input): the parsed body or query lands on
 *  res.locals.body or res.locals.query. A failure throws the ZodError, which the error handler answers as 400
 *  validation_error with details[]. */
export const validate =
  (schema: ZodType, source: 'body' | 'query' = 'body'): RequestHandler =>
  (req, res, next) => {
    res.locals[source] = schema.parse(req[source]);
    next();
  };
