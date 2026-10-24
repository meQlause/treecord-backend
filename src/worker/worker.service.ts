// Runs the worker's loops (indexer, relayer lanes, scheduler) in one process. Each loop runs on its own timer and
// keeps going immediately while it has work. The entry (src/worker.ts) builds the loops; this file runs them.
import { describeError } from '../shared/chain/wallets.js';
import type { IndexerStatus } from './indexer/indexer.service.js';
import { Metrics } from './metrics.js';
import type { Logger } from './worker-db.repository.js';

/** NFR-076: only `all` and `relayer` send transactions, and exactly one such process runs per wallet pair. */
export type WorkerMode = 'all' | 'indexer' | 'relayer';

export type Loop = {
  name: string;
  intervalMs: number;
  /** Returns true when it did work and should run again right away. */
  run: () => Promise<boolean>;
};

type LoopFactories = {
  /** The indexer loop. */
  indexer: () => Loop[];
  /** The three relayer lanes and the scheduler. */
  relayer: () => Loop[];
};

type LoopHealth = {
  name: string;
  healthy: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type WorkerHealth = {
  ok: boolean;
  mode: WorkerMode;
  chainId: number;
  loops: LoopHealth[];
  indexer: { lastBlock: string | null; head: string | null; lagBlocks: number | null } | null;
};

export type WorkerOptions = {
  mode: WorkerMode;
  loops: LoopFactories;
  log: Logger;
  chainId: number;
  workerId: string;
  metrics?: Metrics;
  indexerStatus?: () => IndexerStatus | null;
};

type LoopState = Loop & { lastSuccessAt: Date | null; lastError: string | null };

/** A loop is unhealthy when it has not succeeded for this many intervals, plus a minute. */
const STALE_INTERVALS = 10;
const STALE_GRACE_MS = 60_000;

/** The loops a mode runs; only the factories it needs are called. */
const loopsFor = (mode: WorkerMode, factories: LoopFactories): Loop[] => [
  ...(mode === 'relayer' ? [] : factories.indexer()),
  ...(mode === 'indexer' ? [] : factories.relayer()),
];

const indexerHealth = (status: IndexerStatus | null | undefined): WorkerHealth['indexer'] => {
  if (!status) {
    return null;
  }

  const { lastBlock, head } = status;

  return {
    lastBlock: lastBlock?.toString() ?? null,
    head: head?.toString() ?? null,
    lagBlocks: lastBlock !== null && head !== null ? Number(head - lastBlock) : null,
  };
};

export class Worker {
  readonly metrics: Metrics;
  private readonly loops: LoopState[];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private stopped = true;

  constructor(private readonly options: WorkerOptions) {
    this.metrics = options.metrics ?? new Metrics();
    this.loops = loopsFor(options.mode, options.loops).map((loop) => ({
      ...loop,
      lastSuccessAt: null,
      lastError: null,
    }));
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;

    for (const loop of this.loops) {
      this.schedule(loop, 0);
    }

    this.options.log.info(
      {
        mode: this.options.mode,
        loops: this.loops.map((loop) => loop.name),
        worker: this.options.workerId,
      },
      'worker started',
    );
  }

  /** Stops scheduling and waits for the loops' current iterations to finish. */
  async stop(): Promise<void> {
    this.stopped = true;

    for (const timer of this.timers) {
      clearTimeout(timer);
    }

    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }

  health(): WorkerHealth {
    const now = Date.now();
    const loops = this.loops.map((loop): LoopHealth => {
      // before its first success a loop is healthy until it reports an error
      const healthy =
        loop.lastSuccessAt === null
          ? loop.lastError === null
          : now - loop.lastSuccessAt.getTime() < loop.intervalMs * STALE_INTERVALS + STALE_GRACE_MS;

      return {
        name: loop.name,
        healthy,
        lastSuccessAt: loop.lastSuccessAt?.toISOString() ?? null,
        lastError: loop.lastError,
      };
    });

    return {
      ok: !this.stopped && loops.every((loop) => loop.healthy),
      mode: this.options.mode,
      chainId: this.options.chainId,
      loops,
      indexer: indexerHealth(this.options.indexerStatus?.()),
    };
  }

  private schedule(loop: LoopState, delayMs: number): void {
    if (this.stopped) {
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const iteration = this.iterate(loop);

      this.running.add(iteration);
      void iteration.finally(() => this.running.delete(iteration));
    }, delayMs);

    this.timers.add(timer);
  }

  private async iterate(loop: LoopState): Promise<void> {
    let again = false;

    try {
      again = await loop.run();
      loop.lastSuccessAt = new Date();
      loop.lastError = null;
    } catch (error) {
      loop.lastError = describeError(error);
      this.metrics.inc(`${loop.name}.errors`);
      this.options.log.error({ loop: loop.name, error: loop.lastError }, 'loop iteration failed');
    }

    this.schedule(loop, again ? 0 : loop.intervalMs);
  }
}
