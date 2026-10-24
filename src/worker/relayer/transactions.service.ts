// The steps every relayer lane shares: send a transaction for some jobs, wait for its receipt, and record the
// outcome on the jobs (and on an attestation's submissions).
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Hex,
} from 'viem';
import {
  describeError,
  revertErrorName,
  type ChainClients,
  type Wallet,
} from '../../shared/chain/wallets.js';
import type { Metrics } from '../metrics.js';
import { transitionSubmission } from '../scoring/submissions.repository.js';
import type { Db, Logger } from '../worker-db.repository.js';
import { InvalidPayloadError, type PreparedCall } from './calls.rules.js';
import type { NonceManager } from './nonces.js';
import { recordAttestationTx, updateJob, type Job } from './relayer.repository.js';
import {
  afterConfirmed,
  afterFailure,
  afterReceiptTimeout,
  afterSent,
  classifyRevert,
  type Failure,
  type JobUpdate,
} from './state.rules.js';

export type TransactionsOptions = {
  db: Db;
  clients: ChainClients;
  nonces: NonceManager;
  log: Logger;
  metrics: Metrics;
  receiptTimeoutMs: number;
};

type ReceiptState = 'success' | 'reverted' | 'pending' | 'missing';

const submissionIdOf = (job: Job): string | undefined =>
  (job.payload as { submissionId?: string } | null)?.submissionId;

export class JobTransactions {
  constructor(private readonly options: TransactionsOptions) {}

  update(job: Job, update: JobUpdate): Promise<void> {
    return updateJob(this.options.db, job.id, update, new Date());
  }

  async confirm(jobs: Job[], hash: Hex | null): Promise<void> {
    for (const job of jobs) {
      await this.update(job, afterConfirmed(hash));
      this.options.metrics.inc(`relayer.${job.kind}.confirmed`);
    }
  }

  async fail(job: Job, error: unknown): Promise<void> {
    const { log, metrics } = this.options;
    const message = describeError(error);
    const failure: Failure =
      error instanceof InvalidPayloadError ||
      classifyRevert(job.kind, revertErrorName(error)) === 'permanent'
        ? 'permanent'
        : 'transient';
    const update = afterFailure(job, failure, message);

    try {
      await this.update(job, update);

      if (update.status === 'failed') {
        await this.onFailed(job, message);
      }
    } catch (writeError) {
      // the job stays locked and is reclaimed after the stale timeout
      log.error({ job: job.id, error: describeError(writeError) }, 'could not record job failure');
    }

    metrics.inc(`relayer.${job.kind}.${update.status === 'failed' ? 'failed' : 'retried'}`);
    log.warn(
      {
        job: job.id,
        kind: job.kind,
        attempts: job.attempts,
        status: update.status,
        error: message,
      },
      'job attempt failed',
    );
  }

  /**
   * For a job that already broadcast a transaction on an earlier attempt: confirms it if mined, or waits if still
   * pending. Returns false when the earlier transaction failed or vanished, so the job is sent again.
   */
  async settledBySentTx(job: Job): Promise<boolean> {
    if (!job.tx_hash) {
      return false;
    }

    const state = await this.receiptState(job.tx_hash as Hex);

    if (state === 'success') {
      await this.confirm([job], job.tx_hash as Hex);

      return true;
    }

    if (state === 'pending') {
      await this.update(job, afterReceiptTimeout());

      return true;
    }

    return false;
  }

  /** Sends one transaction for `jobs`, records it, and waits for the receipt. */
  async broadcast(jobs: Job[], call: PreparedCall, wallet: Wallet): Promise<void> {
    const { nonces, log, metrics } = this.options;
    let hash: Hex;

    try {
      hash = await nonces.withNonce(wallet.account.address, (nonce) => call.send(wallet, nonce));
    } catch (error) {
      await this.failAll(jobs, error);

      return;
    }

    for (const job of jobs) {
      await this.update(job, afterSent(hash));
    }

    await this.onSent(jobs, hash);
    log.info(
      { tx: hash, jobs: jobs.map((job) => job.id), call: call.description },
      'transaction sent',
    );
    metrics.inc(`relayer.${jobs[0]?.kind ?? 'unknown'}.sent`);
    await this.settle(jobs, hash);
  }

  private async settle(jobs: Job[], hash: Hex): Promise<void> {
    let status: 'success' | 'reverted';

    try {
      status = (
        await this.options.clients.public.waitForTransactionReceipt({
          hash,
          timeout: this.options.receiptTimeoutMs,
        })
      ).status;
    } catch (error) {
      if (!(error instanceof WaitForTransactionReceiptTimeoutError)) {
        throw error;
      }

      for (const job of jobs) {
        await this.update(job, afterReceiptTimeout());
      }

      this.options.log.warn({ tx: hash }, 'receipt not seen in time, will check again');

      return;
    }

    if (status === 'success') {
      await this.confirm(jobs, hash);

      return;
    }

    await this.failAll(jobs, new Error(`transaction ${hash} reverted`));
  }

  private async failAll(jobs: Job[], error: unknown): Promise<void> {
    for (const job of jobs) {
      await this.fail(job, error);
    }
  }

  private async receiptState(hash: Hex): Promise<ReceiptState> {
    const client = this.options.clients.public;

    try {
      return (await client.getTransactionReceipt({ hash })).status;
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) {
        throw error;
      }
    }

    try {
      await client.getTransaction({ hash });

      return 'pending';
    } catch (error) {
      if (error instanceof TransactionNotFoundError) {
        return 'missing';
      }

      throw error;
    }
  }

  private async onSent(jobs: Job[], hash: Hex): Promise<void> {
    const ids = jobs
      .filter((job) => job.kind === 'attestation')
      .map(submissionIdOf)
      .filter((id): id is string => typeof id === 'string');

    if (ids.length > 0) {
      await recordAttestationTx(this.options.db, ids, hash);
    }
  }

  /** A permanently failed attestation fails its submission, with the reason shown to the planter. */
  private async onFailed(job: Job, message: string): Promise<void> {
    const submissionId = job.kind === 'attestation' ? submissionIdOf(job) : undefined;

    if (submissionId) {
      await transitionSubmission(this.options.db, submissionId, ['attested'], {
        status: 'failed',
        error: message,
      });
    }
  }
}
