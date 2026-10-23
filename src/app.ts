import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { healthRouter, type ReadinessProbes } from './features/health/health.routes.js';
import { errorHandler, notFound } from './shared/http/error-handler.js';
import { requestId } from './shared/http/request-id.js';

export type AppDependencies = {
  readiness: ReadinessProbes;
  logger: Logger;
  jsonBodyLimitKb: number;
};

/** Builds the Express app; middleware order is docs/BE/be-architecture.md §5. */
export const createApp = ({ readiness, logger, jsonBodyLimitKb }: AppDependencies): Express =>
  express()
    .use(requestId)
    .use(pinoHttp({ logger, genReqId: (_req, res) => String(res.getHeader('x-request-id')) }))
    .use(express.json({ limit: `${jsonBodyLimitKb}kb` }))
    .use(healthRouter(readiness))
    .use(notFound)
    .use(
      errorHandler({
        logUnexpected: (error, id) =>
          logger.error({ err: error, requestId: id }, 'unexpected error'),
      }),
    );
