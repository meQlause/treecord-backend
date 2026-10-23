import express, { type Express } from 'express';
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
};

/** Builds the Express app; middleware order is docs/BE/be-architecture.md §5. */
export const createApp = ({ readiness, logger, jsonBodyLimitKb, auth }: AppDependencies): Express =>
  express()
    .use(requestId)
    .use(pinoHttp({ logger, genReqId: (_req, res) => String(res.getHeader('x-request-id')) }))
    .use(express.json({ limit: `${jsonBodyLimitKb}kb` }))
    .use(healthRouter(readiness))
    .use('/api/v1', authenticate(auth))
    .use(notFound)
    .use(
      errorHandler({
        logUnexpected: (error, id) =>
          logger.error({ err: error, requestId: id }, 'unexpected error'),
      }),
    );
