import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';
import type { Router } from 'express';
import type { Logger } from 'pino';
import type { PublicClient } from 'viem';
import type { Config } from './config.js';
import { registerAccounts, type AccountsCradle } from './features/accounts/accounts.container.js';
import {
  registerCampaigns,
  type CampaignsCradle,
} from './features/campaigns/campaigns.container.js';
import { campaignsRouter } from './features/campaigns/index.js';
import { accountsRouter } from './features/accounts/index.js';
import { registerJobs, type JobsCradle } from './features/jobs/jobs.container.js';
import { jobsRouter } from './features/jobs/index.js';
import { reportsRouter } from './features/reports/index.js';
import { registerReports, type ReportsCradle } from './features/reports/reports.container.js';
import { registerTrees, type TreesCradle } from './features/trees/trees.container.js';
import { treesRouter } from './features/trees/index.js';
import {
  privyEmbeddedWallet,
  privyJwks,
  privyVerifier,
  type TokenVerifier,
} from './shared/auth/privy.js';
import { createChainClient } from './shared/chain/client.js';
import { chainClock } from './shared/chain/clock.js';
import { createDatabase, type DatabaseClient } from './shared/db/database.js';
import { authenticateIfPresent, type AuthOptions } from './shared/http/auth.js';
import { createLogger } from './shared/http/logger.js';
import { createStorage, type Storage } from './shared/storage/storage.js';

/** Shared singletons (be-architecture §6). */
type SharedCradle = {
  config: Config;
  logger: Logger;
  database: DatabaseClient;
  chain: PublicClient;
  /** The latest block's time: "now" for every deadline (ADR-015). */
  chainNow: () => Promise<Date>;
  /** The server clock; injected so tests fix it (SR-1). */
  clock: () => Date;
  storage: Storage;
  verifyToken: TokenVerifier;
  walletOf: (privyUserId: string) => Promise<string | null>;
};

/** Every registration; a misspelt dependency name is a compile error (SR-1). */
export type Cradle = SharedCradle &
  AccountsCradle &
  JobsCradle &
  CampaignsCradle &
  TreesCradle &
  ReportsCradle;

/** The composition root: shared singletons, then each feature's register(). */
export const createRootContainer = (config: Config): AwilixContainer<Cradle> => {
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });

  container.register({
    config: asValue(config),
    logger: asFunction(({ config: settings }: Cradle) =>
      createLogger(settings.LOG_LEVEL),
    ).singleton(),
    database: asFunction(({ config: settings, logger }: Cradle) =>
      createDatabase({
        url: settings.DATABASE_URL,
        poolMax: settings.DATABASE_POOL_MAX,
        timeoutMs: settings.DATABASE_STATEMENT_TIMEOUT_MS,
        onConnectionError: (error) => logger.warn({ err: error }, 'postgres connection dropped'),
      }),
    )
      .singleton()
      .disposer((database) => database.destroy()),
    chain: asFunction(({ config: settings }: Cradle) =>
      createChainClient(settings.RPC_URL, settings.RPC_TIMEOUT_MS),
    ).singleton(),
    chainNow: asFunction(({ chain }: Cradle) => chainClock(chain)).singleton(),
    clock: asValue(() => new Date()),
    storage: asFunction(({ config: settings }: Cradle) => createStorage(settings)).singleton(),
    verifyToken: asFunction(({ config: settings }: Cradle) =>
      privyVerifier({ appId: settings.PRIVY_APP_ID, resolveKey: privyJwks(settings.PRIVY_APP_ID) }),
    ).singleton(),
    walletOf: asFunction(({ config: settings }: Cradle) =>
      privyEmbeddedWallet({
        appId: settings.PRIVY_APP_ID,
        appSecret: settings.PRIVY_APP_SECRET,
        timeoutMs: settings.RPC_TIMEOUT_MS,
      }),
    ).singleton(),
  });
  registerAccounts(container);
  registerJobs(container);
  registerCampaigns(container);
  registerTrees(container);
  registerReports(container);

  return container;
};

/** How the API signs a caller in (be-architecture §5 row 7). */
export const authOptions = ({ config, verifyToken, accountsService }: Cradle): AuthOptions => ({
  verify: verifyToken,
  demoWalletAuth: config.DEMO_WALLET_AUTH,
  resolveProfile: accountsService.resolveProfile,
});

/** Every router mounted before authentication; the access matrix covers each too. */
export const publicRouters = (cradle: Cradle): Router[] => {
  const signedInIfToken = authenticateIfPresent(authOptions(cradle));

  return [
    campaignsRouter(cradle.campaignsService, signedInIfToken),
    treesRouter(cradle.treesService, signedInIfToken),
    reportsRouter(cradle.reportsService),
  ];
};

/** Every router mounted behind authentication; the access matrix (tests/integration/container.test.ts) covers each. */
export const privateRouters = ({ accountsService, jobsService }: Cradle): Router[] => [
  accountsRouter(accountsService),
  jobsRouter(jobsService),
];
