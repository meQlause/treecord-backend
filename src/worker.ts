// The worker's process entry (ADR-021): config, database, chain clients, the worker's loops, the health server and
// graceful shutdown. Started with `npm run worker`, beside the API (`npm start`). NFR-076: run exactly one process
// in `all` or `relayer` mode per operator and relayer wallet.
import { hostname } from 'node:os';
import { pino } from 'pino';
import type { Hex } from 'viem';
import { readWorkerConfig, type WorkerConfig } from './config.js';
import { getDeployment } from './generated/frozen/addresses.js';
import { Attester } from './generated/frozen/attester.js';
import { createChainClients } from './shared/chain/wallets.js';
import { createWorkerDatabase } from './shared/db/worker-database.js';
import { createWorkerStorage } from './shared/storage/storage.js';
import { createWorker } from './worker/create-worker.js';
import { startHealthServer } from './worker/health.server.js';
import { createAiClient } from './worker/scoring/ai-client.js';
import type { Logger } from './worker/worker-db.repository.js';

const build = (config: WorkerConfig, log: Logger) => {
  const deployment = getDeployment(config.CHAIN_ID);
  const db = createWorkerDatabase({
    url: config.DATABASE_URL,
    poolMax: config.WORKER_DATABASE_POOL_MAX,
    onConnectionError: (error) => log.error({ error: error.message }, 'postgres connection error'),
  });
  const clients = createChainClients({
    rpcUrl: config.RPC_URL,
    chainId: config.CHAIN_ID,
    operatorKey: config.OPERATOR_PRIVATE_KEY as Hex,
    relayerKey: config.RELAYER_PRIVATE_KEY as Hex,
  });
  const worker = createWorker({
    mode: config.WORKER_MODE,
    db,
    clients,
    deployment,
    log,
    workerId: `${hostname()}:${process.pid}`,
    scoreDeps: {
      db,
      storage: createWorkerStorage(config),
      attester: new Attester(
        config.ATTESTER_PRIVATE_KEY as Hex,
        config.CHAIN_ID,
        deployment.verificationGateway,
      ),
      chainNow: async () =>
        Number((await clients.public.getBlock({ blockTag: 'latest' })).timestamp),
      ai: createAiClient(config),
      log,
    },
    tuning: {
      indexerPollMs: config.INDEXER_POLL_MS,
      relayerPollMs: config.RELAYER_POLL_MS,
      schedulerIntervalMs: config.SCHEDULER_INTERVAL_MS,
      autoFund: config.AUTO_FUND,
      indexer: {
        chunkBlocks: config.INDEXER_CHUNK_BLOCKS,
        confirmations: config.INDEXER_CONFIRMATIONS,
        rescanBlocks: config.INDEXER_RESCAN_BLOCKS,
        ...(config.INDEXER_START_BLOCK === undefined
          ? {}
          : { startBlock: BigInt(config.INDEXER_START_BLOCK) }),
      },
    },
  });

  return { worker, db, clients };
};

const main = async (): Promise<void> => {
  const config = readWorkerConfig();
  const log = pino({ level: config.LOG_LEVEL });
  const { worker, db, clients } = build(config, log);
  const server = await startHealthServer({
    port: config.WORKER_PORT,
    health: () => worker.health(),
    metrics: () => worker.metrics.snapshot(),
  });

  log.info(
    {
      chainId: config.CHAIN_ID,
      mode: config.WORKER_MODE,
      mockAi: config.MOCK_AI,
      port: config.WORKER_PORT,
      operator: clients.operator.account.address,
      relayer: clients.relayer.account.address,
    },
    'worker listening',
  );
  worker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    server.close();
    await worker.stop();
    await db.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

await main();
