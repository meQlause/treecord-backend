import { asValue } from 'awilix';
import type { Express, Router } from 'express';
import { loadConfig } from '../../src/config.js';
import { createRootContainer, privateRouters } from '../../src/container.js';
import { privyVerifier } from '../../src/shared/auth/privy.js';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { VALID_ENV } from '../fixtures/env.js';
import { testApp } from './app.js';
import { TEST_APP_ID, type FakePrivy } from './fake-privy.js';

export type TestApi = {
  app: Express;
  /** Every router mounted behind authentication, as server.ts mounts them. */
  routers: Router[];
  /** The Authorization header of a signed-in Privy user. */
  signedIn: (privyUserId: string) => Promise<{ Authorization: string }>;
};

/** The production composition (src/container.ts) with only the outside world swapped: the test database, the fake
 *  Privy key, and no embedded wallets. */
export const testApi = (database: DatabaseClient, privy: FakePrivy): TestApi => {
  const { cradle } = createRootContainer(loadConfig(VALID_ENV)).register({
    database: asValue(database),
    verifyToken: asValue(privyVerifier({ appId: TEST_APP_ID, resolveKey: privy.resolveKey })),
    walletOf: asValue(async () => null),
  });
  const routers = privateRouters(cradle);

  return {
    app: testApp({
      auth: {
        verify: cradle.verifyToken,
        demoWalletAuth: false,
        resolveProfile: cradle.accountsService.resolveProfile,
      },
      privateRouters: routers,
    }),
    routers,
    signedIn: async (privyUserId) => ({
      Authorization: `Bearer ${await privy.token({ userId: privyUserId })}`,
    }),
  };
};
