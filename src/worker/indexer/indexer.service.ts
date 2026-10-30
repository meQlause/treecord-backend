// Polls Treecord contract logs into the PostgreSQL mirror (NFR-022: each event applied once, 2 confirmations).
import type { Address, PublicClient } from 'viem';
import type { TreecordDeployment } from '../../generated/frozen/addresses.js';
import type { Metrics } from '../metrics.js';
import { inTransaction, type Db, type Logger } from '../worker-db.repository.js';
import { applyEvent } from './apply.service.js';
import { decodeLogs, lower, type RawLog, type WatchedAddresses } from './decode.rules.js';
import { loadCampaignAddresses, readCursor, writeCursor } from './indexer.repository.js';
import { nextRange, type IndexRange } from './range.rules.js';

export type IndexerOptions = {
  db: Db;
  client: PublicClient;
  deployment: TreecordDeployment;
  log: Logger;
  metrics: Metrics;
  /** Row in chain_cursor. Lets tests and parallel deployments keep separate cursors. */
  cursorName?: string;
  /** First block to index when there is no cursor yet. Defaults to the deploy block. */
  startBlock?: bigint;
  /** Blocks per eth_getLogs call. */
  chunkBlocks?: number;
  /** Only blocks this deep are indexed. */
  confirmations?: number;
  /** Already indexed blocks scanned again every cycle, to pick up reorged logs. */
  rescanBlocks?: number;
  /** The Chainlink keeper whose Enforced events are mirrored (FR-243); none when unset. */
  keeperAddress?: Address;
};

export type TickResult = IndexRange & {
  /** True when the confirmed head is reached, so the next cycle can wait for new blocks. */
  caughtUp: boolean;
};

export type IndexerStatus = {
  lastBlock: bigint | null;
  head: bigint | null;
  lastRunAt: Date | null;
};

const DEFAULTS = { chunkBlocks: 2_000, confirmations: 2, rescanBlocks: 5 };
const MS_PER_SECOND = 1000;
/** Old block timestamps are not needed again after the re-scan window. */
const MAX_CACHED_BLOCK_TIMES = 10_000;

const toRawLogs = (logs: Awaited<ReturnType<PublicClient['getLogs']>>): RawLog[] =>
  logs.flatMap((entry) =>
    entry.blockNumber === null || entry.logIndex === null || entry.transactionHash === null
      ? []
      : [
          {
            address: entry.address,
            blockNumber: entry.blockNumber,
            logIndex: entry.logIndex,
            transactionHash: entry.transactionHash,
            data: entry.data,
            topics: entry.topics,
          },
        ],
  );

export class Indexer {
  readonly cursorName: string;
  private readonly startBlock: bigint;
  private readonly chunkBlocks: number;
  private readonly confirmations: number;
  private readonly rescanBlocks: number;
  private readonly watched: WatchedAddresses;
  private campaignsLoaded = false;
  private readonly blockTimes = new Map<bigint, string>();
  private warnedCursorAhead = false;

  /** Last indexed block and chain head, for /health. */
  status: IndexerStatus = { lastBlock: null, head: null, lastRunAt: null };

  constructor(private readonly options: IndexerOptions) {
    const deployment = options.deployment;

    this.cursorName = options.cursorName ?? `indexer:${deployment.chainId}`;
    this.startBlock = options.startBlock ?? deployment.deployBlock;
    this.chunkBlocks = options.chunkBlocks ?? DEFAULTS.chunkBlocks;
    this.confirmations = options.confirmations ?? DEFAULTS.confirmations;
    this.rescanBlocks = options.rescanBlocks ?? DEFAULTS.rescanBlocks;
    this.watched = {
      factory: lower(deployment.campaignFactory),
      treeRegistry: lower(deployment.treeRegistry),
      gateway: lower(deployment.verificationGateway),
      carbonLedger: lower(deployment.carbonLedger),
      keeper: options.keeperAddress === undefined ? null : lower(options.keeperAddress),
      campaigns: new Set(),
    };
  }

  /**
   * Indexes one chunk. Returns the range indexed, or null when the confirmed head has nothing new. The chunk's
   * writes and the cursor share one transaction (ADR-004) and the cursor moves last, so a crash replays the chunk.
   * Every write stays idempotent, so a replay ends in the same state.
   */
  async tick(): Promise<TickResult | null> {
    await this.loadCampaigns();

    const head = await this.options.client.getBlockNumber();
    const cursor = await readCursor(this.options.db, this.cursorName);

    this.status = { ...this.status, head, lastBlock: cursor, lastRunAt: new Date() };

    if (this.cursorAhead(cursor, head)) {
      return null;
    }

    const range = nextRange({
      cursor,
      startBlock: this.startBlock,
      head,
      confirmations: this.confirmations,
      chunkBlocks: this.chunkBlocks,
      rescanBlocks: this.rescanBlocks,
    });

    if (!range) {
      return null;
    }

    const events = await this.apply(range);

    this.report(range, head, events);

    return { ...range, caughtUp: range.toBlock >= head - BigInt(this.confirmations) };
  }

  /** Indexes chunks until the confirmed head is reached. */
  async catchUp(): Promise<void> {
    for (;;) {
      const result = await this.tick();

      if (!result || result.caughtUp) {
        return;
      }
    }
  }

  /**
   * On anvil a cursor past the head means the chain was restarted under an old database. Re-indexing over stale
   * mirror rows would mix two chains, so the indexer waits and says what to do instead.
   */
  private cursorAhead(cursor: bigint | null, head: bigint): boolean {
    if (cursor === null || cursor <= head) {
      return false;
    }

    if (!this.warnedCursorAhead) {
      this.options.log.warn(
        { cursor: cursor.toString(), head: head.toString(), cursorName: this.cursorName },
        'Chain head is behind the indexer cursor. If a local chain was restarted, reset the database (docker compose down, docker compose up -d, npm run db:migrate).',
      );
      this.warnedCursorAhead = true;
    }

    return true;
  }

  /** Two passes: campaigns created in the range first, so their own logs in the same range are fetched too. */
  private async apply(range: IndexRange): Promise<number> {
    const created = await this.getLogs([this.watched.factory], range);

    for (const indexed of decodeLogs(created, this.watched)) {
      if (indexed.source === 'factory' && indexed.event.eventName === 'CampaignCreated') {
        this.watched.campaigns.add(lower(indexed.event.args.campaign));
      }
    }

    const addresses: Address[] = [
      this.watched.factory,
      this.watched.treeRegistry,
      this.watched.gateway,
      this.watched.carbonLedger,
      ...(this.watched.keeper === null ? [] : [this.watched.keeper]),
      ...this.watched.campaigns,
    ];
    const events = decodeLogs(await this.getLogs(addresses, range), this.watched);
    const { deployment, log, metrics } = this.options;

    await inTransaction(this.options.db, async (transaction) => {
      const context = {
        db: transaction,
        chainId: deployment.chainId,
        carbonLedger: this.watched.carbonLedger,
        blockTime: (block: bigint) => this.blockTime(block),
        log,
      };

      for (const indexed of events) {
        await applyEvent(context, indexed);
        metrics.inc(`indexer.events.${indexed.event.eventName}`);
      }

      await writeCursor(transaction, this.cursorName, range.toBlock);
    });

    return events.length;
  }

  private report(range: IndexRange, head: bigint, events: number): void {
    const { log, metrics } = this.options;

    this.status = { ...this.status, lastBlock: range.toBlock };
    metrics.inc('indexer.chunks');
    metrics.set('indexer.lastBlock', Number(range.toBlock));
    metrics.set('indexer.lagBlocks', Number(head - range.toBlock));

    if (events > 0) {
      log.info(
        { from: Number(range.fromBlock), to: Number(range.toBlock), events },
        'indexed chunk',
      );
    }

    if (this.blockTimes.size > MAX_CACHED_BLOCK_TIMES) {
      this.blockTimes.clear();
    }
  }

  private async getLogs(addresses: Address[], range: IndexRange): Promise<RawLog[]> {
    const logs = await this.options.client.getLogs({
      address: addresses,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });

    return toRawLogs(logs);
  }

  private async blockTime(blockNumber: bigint): Promise<string> {
    const cached = this.blockTimes.get(blockNumber);

    if (cached) {
      return cached;
    }

    const block = await this.options.client.getBlock({ blockNumber });
    const time = new Date(Number(block.timestamp) * MS_PER_SECOND).toISOString();

    this.blockTimes.set(blockNumber, time);

    return time;
  }

  /** Campaign clones already mirrored. New ones are added from CampaignCreated as they are indexed. */
  private async loadCampaigns(): Promise<void> {
    if (this.campaignsLoaded) {
      return;
    }

    const addresses = await loadCampaignAddresses(this.options.db, this.options.deployment.chainId);

    for (const address of addresses) {
      this.watched.campaigns.add(lower(address as Address));
    }

    this.campaignsLoaded = true;
  }
}
