import express, { type Express } from 'express';
import { healthRouter, type ReadinessProbes } from './features/health/health.routes.js';

export type AppDependencies = { readiness: ReadinessProbes };

/** Builds the Express app; middleware order is docs/BE/be-architecture.md §5. */
export const createApp = ({ readiness }: AppDependencies): Express =>
  express().use(healthRouter(readiness));
