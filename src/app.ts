import express, { type Express, type Router } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { healthRouter, type ReadinessProbes } from './features/health/health.routes.js';
import { authenticate, type AuthOptions } from './shared/http/auth.js';
import { errorHandler, notFound } from './shared/http/error-handler.js';
import { requestId } from './shared/http/request-id.js';

export type AppDependencies = {
  readiness: ReadinessProbes;
  logger: Logger;
  jsonBodyLimitKb: number;
  auth: AuthOptions;
  /** Feature routers anyone may call, mounted under /api/v1 before authentication (be-architecture §5 row 6). */
  publicRouters: Router[];
  /** Feature routers that need a signed-in caller, mounted under /api/v1 (be-architecture §5 row 8). */
  privateRouters: Router[];
};

/** Builds the Express app; middleware order is docs/BE/be-architecture.md §5. */
export const createApp = ({
  readiness,
  logger,
  jsonBodyLimitKb,
  auth,
  publicRouters,
  privateRouters,
}: AppDependencies): Express => {
  const app = express()
    .use(requestId)
    .use(pinoHttp({ logger, genReqId: (_req, res) => String(res.getHeader('x-request-id')) }))
    .use(express.json({ limit: `${jsonBodyLimitKb}kb` }))
    .use(healthRouter(readiness));

  // one use() each: Express refuses a use() with no handler, and a test app may have no public routers
  for (const router of publicRouters) {
    app.use('/api/v1', router);
  }

  return app
    .use('/api/v1', authenticate(auth), ...privateRouters)
    .use(notFound)
    .use(
      errorHandler({
        logUnexpected: (error, id) =>
          logger.error({ err: error, requestId: id }, 'unexpected error'),
      }),
    );
};
