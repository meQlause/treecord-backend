import express, { type Express } from 'express';
import { healthRouter, type ReadinessProbes } from './features/health/health.routes.js';
import { errorHandler, notFound } from './shared/http/error-handler.js';
import { requestId } from './shared/http/request-id.js';

export type AppDependencies = {
  readiness: ReadinessProbes;
  logUnexpected: (error: unknown, requestId: string) => void;
};

/** Builds the Express app; middleware order is docs/BE/be-architecture.md §5. */
export const createApp = ({ readiness, logUnexpected }: AppDependencies): Express =>
  express()
    .use(requestId)
    .use(healthRouter(readiness))
    .use(notFound)
    .use(errorHandler({ logUnexpected }));
