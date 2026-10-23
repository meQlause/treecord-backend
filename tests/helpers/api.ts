import { asValue } from 'awilix';
import type { Express, Router } from 'express';
import { loadConfig } from '../../src/config.js';
import {
  authOptions,
  createRootContainer,
  privateRouters,
  publicRouters,
} from '../../src/container.js';
import { privyVerifier } from '../../src/shared/auth/privy.js';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { VALID_ENV } from '../fixtures/env.js';
import { testApp } from './app.js';
import { TEST_APP_ID, type FakePrivy } from './fake-privy.js';

/** The chain time the spec's worked examples use (campaigns §1: "chainNow 2026-10-23T03:12:44Z"). */
const CHAIN_NOW = new Date('2026-10-23T03:12:44Z');

/** audit.md §2: the block the open demo session `e9219997-…` was seeded from. */
export const DEMO_AUDIT_BLOCK = {
  number: '17000015',
  hash: '0x39e41cfd9e316d39bb6ad8058c9cfbbb2d19fa7938c68e1e32009e56e735a4cd',
} as const;

export type TestApi = {
  app: Express;
  /** Every router the app mounts under /api/v1, public first, as server.ts mounts them. */
  routers: Router[];
  /** The Authorization header of a signed-in Privy user. */
  signedIn: (privyUserId: string) => Promise<{ Authorization: string }>;
};

type Clocks = {
  /** The latest block's time; defaults to CHAIN_NOW. */
  chainNow?: () => Promise<Date>;
  /** The server clock; defaults to CHAIN_NOW too, so only a test that wants them apart sets it. */
  clock?: () => Date;
  /** A block's timestamp; by default the RPC cannot be reached. */
  blockTime?: (blockNumber: string) => Promise<Date>;
  /** The latest block; defaults to the seed block of audit.md's open demo session. */
  latestBlock?: () => Promise<{ number: string; hash: `0x${string}` }>;
  /** Variables over the valid local environment, e.g. a test MinIO's endpoints. */
  env?: Record<string, string>;
};

/** The production composition (src/container.ts) with only the outside world swapped: the test database, the fake
 *  Privy key, no embedded wallets, and fixed clocks. */
export const testApi = (
  database: DatabaseClient,
  privy: FakePrivy,
  {
    chainNow = async () => CHAIN_NOW,
    clock = () => CHAIN_NOW,
    blockTime = async () => {
      throw new Error('no RPC in this test');
    },
    latestBlock = async () => DEMO_AUDIT_BLOCK,
    env = {},
  }: Clocks = {},
): TestApi => {
  const { cradle } = createRootContainer(loadConfig({ ...VALID_ENV, ...env })).register({
    database: asValue(database),
    verifyToken: asValue(privyVerifier({ appId: TEST_APP_ID, resolveKey: privy.resolveKey })),
    walletOf: asValue(async () => null),
    chainNow: asValue(chainNow),
    clock: asValue(clock),
    blockTime: asValue(blockTime),
    latestBlock: asValue(latestBlock),
  });
  const open = publicRouters(cradle);
  const signedIn = privateRouters(cradle);

  return {
    app: testApp({ auth: authOptions(cradle), publicRouters: open, privateRouters: signedIn }),
    routers: [...open, ...signedIn],
    signedIn: async (privyUserId) => ({
      Authorization: `Bearer ${await privy.token({ userId: privyUserId })}`,
    }),
  };
};
