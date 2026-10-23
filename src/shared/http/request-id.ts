import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

// An incoming id is echoed only when it is safe to put in a log line; anything else gets a fresh one.
const SAFE_ID = /^[\w.-]{1,128}$/;

/** First middleware (be-architecture §5 row 1): one id per request, in the header and the envelope. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : randomUUID();

  res.locals['requestId'] = id;
  res.setHeader('X-Request-Id', id);
  next();
};
