// Processes relayer_jobs in three lanes that run side by side:
// - score:       the evidence scoring pipeline (AI call, policy, attestation signing). No transaction.
// - attestation: VerificationGateway.submit, batched up to 10 per transaction, sent by the relayer wallet.
// - operator:    claim, anchor_assign, estimate, issue, set_price and resolve_flag, sent by the operator wallet.
import type { TreecordDeployment } from '../../generated/frozen/addresses.js';
import {
  attestationJobPayloadSchema,
  scoreJobPayloadSchema,
  type AttestationJobPayload,
} from '../../generated/frozen/jobs.js';
import { revertErrorName, type ChainClients } from '../../shared/chain/wallets.js';
import type { Metrics } from '../metrics.js';
import { resignAttestation } from '../scoring/attest.service.js';
import { processScoreJob, type ScoreDeps } from '../scoring/score.service.js';
import { loadSubmission } from '../scoring/submissions.repository.js';
import type { Db, Logger } from '../worker-db.repository.js';
import { attestationCall, operatorCall, parsePayload } from './calls.rules.js';
import type { NonceManager } from './nonces.js';
import { claimJobs, type Job } from './relayer.repository.js';
import {
  afterConfirmed,
  afterReceiptTimeout,
  classifyRevert,
  type JobKind,
} from './state.rules.js';
import { JobTransactions } from './transactions.service.js';

const OPERATOR_KINDS: JobKind[] = [
  'claim',
  'anchor_assign',
  'estimate',
  'issue',
  'set_price',
  'resolve_flag',
];

/** Re-sign an attestation this close to its expiry instead of sending one that may land too late. */
const EXPIRY_MARGIN_SEC = 30;
const RECHECK_SOON_MS = 1_000;
const DEFAULTS = {
  receiptTimeoutMs: 90_000,
  attestationBatch: 10,
  operatorBatch: 5,
  scoreBatch: 3,
};

export type RelayerOptions = {
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  nonces: NonceManager;
  log: Logger;
  metrics: Metrics;
  /** Recorded in relayer_jobs.locked_by. */
  workerId: string;
  /** AI client, attester and chain clock for score jobs and re-signing. */
  scoreDeps: ScoreDeps;
  receiptTimeoutMs?: number;
  attestationBatchSize?: number;
  operatorBatchSize?: number;
  scoreBatchSize?: number;
};

export class Relayer {
  private readonly transactions: JobTransactions;

  constructor(private readonly options: RelayerOptions) {
    this.transactions = new JobTransactions({
      db: options.db,
      clients: options.clients,
      nonces: options.nonces,
      log: options.log,
      metrics: options.metrics,
      receiptTimeoutMs: options.receiptTimeoutMs ?? DEFAULTS.receiptTimeoutMs,
    });
  }

  /** Claims and runs due score jobs. Returns how many were claimed. */
  async tickScore(): Promise<number> {
    const jobs = await this.claim(['score'], this.options.scoreBatchSize ?? DEFAULTS.scoreBatch);

    await Promise.all(jobs.map((job) => this.runScoreJob(job)));

    return jobs.length;
  }

  /** Claims up to 10 attestation jobs, drops the ones that would revert, and sends the rest in one tx. */
  async tickAttestations(): Promise<number> {
    const jobs = await this.claim(
      ['attestation'],
      this.options.attestationBatchSize ?? DEFAULTS.attestationBatch,
    );
    const ready: { job: Job; payload: AttestationJobPayload }[] = [];

    for (const job of jobs) {
      const payload = await this.prepareAttestation(job).catch(async (error: unknown) => {
        await this.transactions.fail(job, error);

        return null;
      });

      if (payload) {
        ready.push({ job, payload });
      }
    }

    if (ready.length > 0) {
      await this.transactions.broadcast(
        ready.map((entry) => entry.job),
        attestationCall(
          ready.map((entry) => entry.payload),
          this.options.deployment,
        ),
        this.options.clients.relayer,
      );
    }

    return jobs.length;
  }

  /** Claims due operator jobs and sends them one after another. */
  async tickOperator(): Promise<number> {
    const jobs = await this.claim(
      OPERATOR_KINDS,
      this.options.operatorBatchSize ?? DEFAULTS.operatorBatch,
    );

    for (const job of jobs) {
      await this.runOperatorJob(job).catch((error: unknown) => this.transactions.fail(job, error));
    }

    return jobs.length;
  }

  private claim(kinds: JobKind[], limit: number): Promise<Job[]> {
    return claimJobs(this.options.db, kinds, limit, this.options.workerId);
  }

  private async runScoreJob(job: Job): Promise<void> {
    try {
      const { submissionId } = parsePayload(scoreJobPayloadSchema, 'score', job.payload);
      const outcome = await processScoreJob(this.options.scoreDeps, submissionId, {
        finalAttempt: job.attempts >= job.max_attempts,
      });

      await this.transactions.update(job, afterConfirmed(null));
      this.options.metrics.inc(`relayer.score.${outcome.skipped ? 'skipped' : outcome.status}`);
      this.options.log.info(
        { job: job.id, submission: submissionId, status: outcome.status },
        'scored submission',
      );
    } catch (error) {
      await this.transactions.fail(job, error);
    }
  }

  private async runOperatorJob(job: Job): Promise<void> {
    if (await this.transactions.settledBySentTx(job)) {
      return;
    }

    const call = operatorCall(job.kind, job.payload, this.options.deployment);

    await call.simulate(this.options.clients.public, this.options.clients.operator.account);
    await this.transactions.broadcast([job], call, this.options.clients.operator);
  }

  /** The payload ready to send, or null when the job was settled, re-signed for later, or already on-chain. */
  private async prepareAttestation(job: Job): Promise<AttestationJobPayload | null> {
    const parsed = parsePayload(attestationJobPayloadSchema, 'attestation', job.payload);

    if (await this.transactions.settledBySentTx(job)) {
      return null;
    }

    const payload = await this.freshPayload(parsed);

    if (!payload) {
      await this.transactions.update(
        job,
        afterReceiptTimeout(RECHECK_SOON_MS, 'could not re-sign now, will reload the job'),
      );

      return null;
    }

    return (await this.simulateAttestation(job, payload)) ? payload : null;
  }

  /** The payload as it is, or re-signed when it is about to expire; null when re-signing was not possible. */
  private async freshPayload(
    payload: AttestationJobPayload,
  ): Promise<AttestationJobPayload | null> {
    const chainNow = await this.options.scoreDeps.chainNow();

    if (chainNow + EXPIRY_MARGIN_SEC < Number(payload.attestation.expiry)) {
      return payload;
    }

    return this.resign(payload);
  }

  /** True when the attestation would be accepted now; settles the job itself when it is done or expired. */
  private async simulateAttestation(job: Job, payload: AttestationJobPayload): Promise<boolean> {
    const { clients, deployment } = this.options;

    try {
      await attestationCall([payload], deployment).simulate(
        clients.public,
        clients.relayer.account,
      );

      return true;
    } catch (error) {
      const verdict = classifyRevert('attestation', revertErrorName(error));

      if (verdict === 'already_done') {
        await this.transactions.update(job, afterConfirmed(null));
        this.options.metrics.inc('relayer.attestation.alreadyOnChain');

        return false;
      }

      if (verdict !== 'expired') {
        throw error;
      }

      await this.resign(payload);
      await this.transactions.update(
        job,
        afterReceiptTimeout(RECHECK_SOON_MS, 'attestation expired, re-signed'),
      );

      return false;
    }
  }

  /** Signs again with a fresh nonce. Returns the new payload, or null if another worker already did. */
  private async resign(payload: AttestationJobPayload): Promise<AttestationJobPayload | null> {
    const submission = await loadSubmission(this.options.db, payload.submissionId);

    if (!submission || submission.status !== 'attested') {
      return null;
    }

    const renewed = await resignAttestation(this.options.scoreDeps, submission, payload.nonce);

    if (!renewed) {
      return null;
    }

    this.options.metrics.inc('relayer.attestation.resigned');
    this.options.log.info(
      {
        submission: submission.id,
        oldNonce: payload.nonce,
        nonce: renewed.record.attestation.nonce,
      },
      're-signed expired attestation',
    );

    return {
      submissionId: submission.id,
      nonce: renewed.record.attestation.nonce,
      attestation: renewed.record.attestation,
      signature: renewed.record.signature,
    };
  }
}
