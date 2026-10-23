import type { Express } from 'express';
import { createApp, type AppDependencies } from '../../src/app.js';
import { DomainError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/http/logger.js';

/** The app with harmless defaults: dependencies ready, silent logs, and every token refused. */
export const testApp = (overrides: Partial<AppDependencies> = {}): Express =>
  createApp({
    readiness: { database: async () => undefined, chain: async () => undefined },
    logger: createLogger('silent'),
    jsonBodyLimitKb: 64,
    auth: {
      verify: async () => {
        throw new DomainError('invalid_token');
      },
      demoWalletAuth: false,
      resolveProfile: async () => {
        throw new Error('not reached: every token is refused');
      },
    },
    publicRouters: [],
    privateRouters: [],
    ...overrides,
  });
