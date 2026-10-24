// Maintenance calls the contracts leave to "anyone", sent by the operator wallet once a minute:
// - Campaign.forfeitMilestone for milestone windows that closed unpaid
// - TreeRegistry.expireDead for dead trees whose replant deadline passed
// - TreeRegistry.markCompleted for alive trees with every milestone settled
// - Campaign.complete for campaigns whose trees are all settled after the commitment period
// Candidates come from the mirror and every call is simulated first, so a stale mirror only costs a simulation.
// Calls are sent back to back with local nonces and their receipts awaited together.
import type { Address, Hex } from 'viem';
import { campaignAbi, treeRegistryAbi } from '../../generated/frozen/abis/index.js';
import type { TreecordDeployment } from '../../generated/frozen/addresses.js';
import { describeError, revertErrorName, type ChainClients } from '../../shared/chain/wallets.js';
import type { Metrics } from '../metrics.js';
import { contractCall, type PreparedCall } from '../relayer/calls.rules.js';
import type { NonceManager } from '../relayer/nonces.js';
import type { Db, Logger } from '../worker-db.repository.js';
import { dueTasks, taskKey, type Task } from './due-tasks.rules.js';
import { loadFacts } from './scheduler.repository.js';

export type SchedulerOptions = {
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  nonces: NonceManager;
  log: Logger;
  metrics: Metrics;
  chainNow: () => Promise<number>;
  /** At most this many calls per run. */
  maxCallsPerRun?: number;
  receiptTimeoutMs?: number;
};

/** A task whose simulation failed is not tried again for this long. */
const SKIP_AFTER_FAILURE_MS = 600_000;
const DEFAULTS = { maxCallsPerRun: 25, receiptTimeoutMs: 90_000 };

type Sent = { task: Task; hash: Hex };

export class Scheduler {
  private readonly skipUntil = new Map<string, number>();

  constructor(private readonly options: SchedulerOptions) {}

  /** Runs one maintenance pass. Returns the tasks whose transactions succeeded. */
  async tick(): Promise<Task[]> {
    const { log, metrics } = this.options;
    const nowSec = await this.options.chainNow();
    const { campaigns, trees } = await loadFacts(this.options.db, this.options.deployment.chainId);
    const nowMs = Date.now();
    const tasks = dueTasks(campaigns, trees, nowSec)
      .filter((task) => (this.skipUntil.get(taskKey(task)) ?? 0) <= nowMs)
      .slice(0, this.options.maxCallsPerRun ?? DEFAULTS.maxCallsPerRun);
    const sent: Sent[] = [];

    for (const task of tasks) {
      const hash = await this.send(task, nowMs);

      if (hash) {
        sent.push({ task, hash });
      }
    }

    const done = (await Promise.all(sent.map((entry) => this.confirmed(entry)))).filter(
      (task): task is Task => task !== null,
    );

    if (done.length > 0) {
      log.info({ calls: done.map(taskKey) }, 'maintenance calls confirmed');
    }

    metrics.inc('scheduler.runs');

    return done;
  }

  /** Simulates and sends one call; null when it would revert (skipped for a while) or could not be sent. */
  private async send(task: Task, nowMs: number): Promise<Hex | null> {
    const { clients, nonces, log } = this.options;
    const operator = clients.operator;
    const call = this.callFor(task);

    try {
      await call.simulate(clients.public, operator.account);
    } catch (error) {
      this.skipUntil.set(taskKey(task), nowMs + SKIP_AFTER_FAILURE_MS);
      log.info(
        { task: taskKey(task), reason: revertErrorName(error) ?? describeError(error) },
        'maintenance call skipped',
      );

      return null;
    }

    try {
      return await nonces.withNonce(operator.account.address, (nonce) =>
        call.send(operator, nonce),
      );
    } catch (error) {
      log.warn({ task: taskKey(task), error: describeError(error) }, 'maintenance call not sent');

      return null;
    }
  }

  private async confirmed({ task, hash }: Sent): Promise<Task | null> {
    const { clients, log, metrics } = this.options;

    try {
      const receipt = await clients.public.waitForTransactionReceipt({
        hash,
        timeout: this.options.receiptTimeoutMs ?? DEFAULTS.receiptTimeoutMs,
      });

      if (receipt.status === 'success') {
        metrics.inc(`scheduler.${task.kind}`);

        return task;
      }

      log.warn({ task: taskKey(task), tx: hash }, 'maintenance call reverted');
    } catch (error) {
      log.warn(
        { task: taskKey(task), tx: hash, error: describeError(error) },
        'maintenance receipt not seen',
      );
    }

    return null;
  }

  private callFor(task: Task): PreparedCall {
    const description = taskKey(task);
    const registry = { address: this.options.deployment.treeRegistry, abi: treeRegistryAbi };

    switch (task.kind) {
      case 'forfeit':
        return contractCall('operator', description, {
          address: task.campaign as Address,
          abi: campaignAbi,
          functionName: 'forfeitMilestone',
          args: [BigInt(task.treeId), task.milestone],
        });
      case 'completeCampaign':
        return contractCall('operator', description, {
          address: task.campaign as Address,
          abi: campaignAbi,
          functionName: 'complete',
          args: [],
        });
      case 'expireDead':
      case 'markCompleted':
        return contractCall('operator', description, {
          ...registry,
          functionName: task.kind,
          args: [BigInt(task.treeId)],
        });
    }
  }
}
