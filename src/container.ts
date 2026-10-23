import { randomBytes } from 'node:crypto';
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';
import type { Router } from 'express';
import type { Logger } from 'pino';
import type { PublicClient } from 'viem';
import type { Config } from './config.js';
import { registerAccounts, type AccountsCradle } from './features/accounts/accounts.container.js';
import { registerAudit, type AuditCradle } from './features/audit/audit.container.js';
import { auditPublicRouter, auditRouter } from './features/audit/index.js';
import {
  registerCampaigns,
  type CampaignsCradle,
} from './features/campaigns/campaigns.container.js';
import { campaignsPrivateRouter, campaignsRouter } from './features/campaigns/index.js';
import { registerCarbon, type CarbonCradle } from './features/carbon/carbon.container.js';
import { carbonPrivateRouter, carbonPublicRouter } from './features/carbon/index.js';
import { registerDevices, type DevicesCradle } from './features/devices/devices.container.js';
import { devicesRouter } from './features/devices/index.js';
import { registerDonor, type DonorCradle } from './features/donor/donor.container.js';
import {
  registerOperations,
  type OperationsCradle,
} from './features/operations/operations.container.js';
import { operationsRouter } from './features/operations/index.js';
import { registerFlags, type FlagsCradle } from './features/flags/flags.container.js';
import { flagsRouter } from './features/flags/index.js';
import { registerEvidence, type EvidenceCradle } from './features/evidence/evidence.container.js';
import { evidenceRouter } from './features/evidence/index.js';
import { planterRouter } from './features/planter/index.js';
import { registerPlanter, type PlanterCradle } from './features/planter/planter.container.js';
import { donorRouter } from './features/donor/index.js';
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
import { verifyWalletToken } from './generated/frozen/wallet-auth.js';
import { createAttester } from './shared/chain/attester.js';
import { blockTime, chainClock, latestBlock } from './shared/chain/clock.js';
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
  /** The latest block's number and hash (audit seeds, FR-182). */
  latestBlock: () => Promise<{ number: string; hash: `0x${string}` }>;
  /** One block's timestamp, for mirror rows stored without it. */
  blockTime: (blockNumber: string) => Promise<Date>;
  /** The server clock; injected so tests fix it (SR-1). */
  clock: () => Date;
  storage: Storage;
  /** Signs operator-approved attestations (ADR-002, ADR-014). */
  attester: ReturnType<typeof createAttester>;
  /** CSPRNG bytes for codes the API issues (NFR-052). */
  randomBytes: (count: number) => Uint8Array;
  verifyToken: TokenVerifier;
  walletOf: (privyUserId: string) => Promise<string | null>;
};

/** Every registration; a misspelt dependency name is a compile error (SR-1). */
export type Cradle = SharedCradle &
  AccountsCradle &
  FlagsCradle &
  AuditCradle &
  OperationsCradle &
  JobsCradle &
  CampaignsCradle &
  TreesCradle &
  ReportsCradle &
  CarbonCradle &
  DonorCradle &
  DevicesCradle &
  PlanterCradle &
  EvidenceCradle;

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
    blockTime: asFunction(({ chain }: Cradle) => blockTime(chain)).singleton(),
    latestBlock: asFunction(({ chain }: Cradle) => latestBlock(chain)).singleton(),
    clock: asValue(() => new Date()),
    randomBytes: asValue((count: number) => new Uint8Array(randomBytes(count))),
    storage: asFunction(({ config: settings, clock }: Cradle) =>
      createStorage(settings, clock),
    ).singleton(),
    attester: asFunction(({ config: settings }: Cradle) =>
      createAttester(settings.ATTESTER_PRIVATE_KEY as `0x${string}`, settings.CHAIN_ID),
    ).singleton(),
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

  // each feature's registrations, in dependency order
  for (const register of [
    registerAccounts,
    registerJobs,
    registerCampaigns,
    registerTrees,
    registerReports,
    registerCarbon,
    registerDonor,
    registerDevices,
    registerPlanter,
    registerEvidence,
    registerFlags,
    registerOperations,
    registerAudit,
  ]) {
    register(container);
  }

  return container;
};

const MS_PER_SECOND = 1000;

/** How the API signs a caller in (be-architecture §5 row 7). */
export const authOptions = ({
  config,
  verifyToken,
  accountsService,
  clock,
}: Cradle): AuthOptions => ({
  verify: verifyToken,
  demoWalletAuth: config.DEMO_WALLET_AUTH,
  verifyWallet: (token) =>
    verifyWalletToken(token, {
      chainId: config.CHAIN_ID,
      nowSec: Math.floor(clock().getTime() / MS_PER_SECOND),
    }),
  resolveProfile: accountsService.resolveProfile,
});

/** Every router mounted before authentication; the access matrix covers each too. */
export const publicRouters = (cradle: Cradle): Router[] => {
  const signedInIfToken = authenticateIfPresent(authOptions(cradle));

  return [
    campaignsRouter(cradle.campaignsService, signedInIfToken),
    treesRouter(cradle.treesService, signedInIfToken),
    reportsRouter(cradle.reportsService),
    carbonPublicRouter(cradle.carbonService),
    auditPublicRouter(cradle.auditService),
  ];
};

/** Every router mounted behind authentication; the access matrix (tests/integration/container.test.ts) covers each. */
export const privateRouters = ({
  accountsService,
  jobsService,
  carbonService,
  donorService,
  devicesService,
  planterService,
  evidenceService,
  campaignsService,
  flagsService,
  operationsService,
  auditService,
}: Cradle): Router[] => [
  accountsRouter(accountsService),
  jobsRouter(jobsService),
  carbonPrivateRouter(carbonService),
  donorRouter(donorService),
  devicesRouter(devicesService),
  planterRouter(planterService),
  evidenceRouter(evidenceService),
  campaignsPrivateRouter(campaignsService),
  flagsRouter(flagsService),
  operationsRouter(operationsService),
  auditRouter(auditService),
];
