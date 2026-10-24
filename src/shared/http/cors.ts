import type { RequestHandler } from 'express';

const NO_CONTENT = 204;
const PREFLIGHT_CACHE_SECONDS = '600';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';
// what the web app sends: the Privy token, JSON bodies, idempotency keys (ADR-009) and its request id
const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key, X-Request-Id';

/**
 * Third middleware (be-architecture §5 row 3): only `WEB_ORIGIN` may call the API from a browser. A preflight is
 * answered here, before authentication, or it would reach auth and fail with 401.
 */
export const cors =
  (webOrigin: string): RequestHandler =>
  (req, res, next) => {
    const allowed = req.get('origin') === webOrigin;

    res.vary('Origin');

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', webOrigin);
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }

    if (req.method !== 'OPTIONS' || req.get('access-control-request-method') === undefined) {
      next();

      return;
    }

    if (allowed) {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_CACHE_SECONDS);
    }

    // another origin gets an empty answer without the allow headers, so its browser refuses the request
    res.status(NO_CONTENT).end();
  };
