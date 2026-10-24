// Builds the worker from its parts: the indexer loop and, for `all` and `relayer`, the three relayer lanes and the
// scheduler. Used by the process entry (src/worker.ts) and by the chain tests, so both run the same worker.
import type { TreecordDeployment } from '../generated/frozen/addresses.js';
import type { ChainClients } from '../shared/chain/wallets.js';
import { AutoFunder } from './autofund/autofund.service.js';
import { Indexer, type IndexerOptions } from './indexer/indexer.service.js';
import { Metrics } from './metrics.js';
import { NonceManager } from './relayer/nonces.js';
import { Relayer } from './relayer/relayer.service.js';
import { Scheduler } from './scheduler/scheduler.service.js';
import type { ScoreDeps } from './scoring/score.service.js';
import { Worker, type Loop, type WorkerMode } from './worker.service.js';
import type { Db, Logger } from './worker-db.repository.js';

type WorkerTuning = {
  indexerPollMs: number;
  relayerPollMs: number;
  schedulerIntervalMs: number;
  indexer?: Pick<
    IndexerOptions,
    'cursorName' | 'startBlock' | 'chunkBlocks' | 'confirmations' | 'rescanBlocks'
  >;
  receiptTimeoutMs?: number;
  maxCallsPerRun?: number;
  /** Testnet only: fill campaigns still funding from the operator wallet (AUTO_FUND). */
  autoFund?: boolean;
};

export type WorkerParts = {
  mode: WorkerMode;
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  log: Logger;
  workerId: string;
  /** AI client, storage, attester and chain clock. */
  scoreDeps: ScoreDeps;
  tuning: WorkerTuning;
  metrics?: Metrics;
};

// a new campaign is filled within this long of being indexed
const AUTO_FUND_INTERVAL_MS = 10_000;

const relayerLoops = (parts: WorkerParts, metrics: Metrics): Loop[] => {
  const { db, clients, deployment, log, workerId, scoreDeps, tuning } = parts;
  const nonces = new NonceManager((address) =>
    clients.public.getTransactionCount({ address, blockTag: 'pending' }),
  );
  const relayer = new Relayer({
    db,
    clients,
    deployment,
    nonces,
    log,
    metrics,
    workerId,
    scoreDeps,
    ...(tuning.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: tuning.receiptTimeoutMs }),
  });
  const scheduler = new Scheduler({
    db,
    clients,
    deployment,
    nonces,
    log,
    metrics,
    chainNow: scoreDeps.chainNow,
    ...(tuning.maxCallsPerRun === undefined ? {} : { maxCallsPerRun: tuning.maxCallsPerRun }),
  });
  const poll = tuning.relayerPollMs;
  const funder = tuning.autoFund
    ? new AutoFunder({ db, clients, deployment, nonces, log, metrics })
    : null;
  const autoFund =
    funder === null
      ? []
      : [{ name: 'autofund', intervalMs: AUTO_FUND_INTERVAL_MS, run: () => funder.tick() }];

  return [
    ...autoFund,
    { name: 'relayer.score', intervalMs: poll, run: async () => (await relayer.tickScore()) > 0 },
    {
      name: 'relayer.attestation',
      intervalMs: poll,
      run: async () => (await relayer.tickAttestations()) > 0,
    },
    {
      name: 'relayer.operator',
      intervalMs: poll,
      run: async () => (await relayer.tickOperator()) > 0,
    },
    {
      name: 'scheduler',
      intervalMs: tuning.schedulerIntervalMs,
      run: async () => {
        await scheduler.tick();

        return false;
      },
    },
  ];
};

export const createWorker = (parts: WorkerParts): Worker => {
  const metrics = parts.metrics ?? new Metrics();
  let indexer: Indexer | null = null;
  const indexerLoops = (): Loop[] => {
    const created = new Indexer({
      db: parts.db,
      client: parts.clients.public,
      deployment: parts.deployment,
      log: parts.log,
      metrics,
      ...parts.tuning.indexer,
    });

    indexer = created;

    return [
      {
        name: 'indexer',
        intervalMs: parts.tuning.indexerPollMs,
        run: async () => {
          const result = await created.tick();

          return result !== null && !result.caughtUp;
        },
      },
    ];
  };

  return new Worker({
    mode: parts.mode,
    log: parts.log,
    chainId: parts.deployment.chainId,
    workerId: parts.workerId,
    metrics,
    indexerStatus: () => indexer?.status ?? null,
    loops: { indexer: indexerLoops, relayer: () => relayerLoops(parts, metrics) },
  });
};
