import type { ZodType } from 'zod';
import {
  anchorAssignJobPayloadSchema,
  attestationJobPayloadSchema,
  claimJobPayloadSchema,
  estimateJobPayloadSchema,
  issueJobPayloadSchema,
  resolveFlagJobPayloadSchema,
  scoreJobPayloadSchema,
  setPriceJobPayloadSchema,
} from '../../generated/frozen/jobs.js';
import type { DatabaseClient, DatabaseTransaction } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import type { EnqueueOutcome } from './jobs.mapper.js';
import {
  jobsRepository,
  type JobKind,
  type JobPayload,
  type JobRow,
  type JobsRepository,
  type StoredJob,
} from './jobs.repository.js';
import { isDerivedKey } from './jobs.rules.js';

/** The signed-in caller, as far as job access needs it. */
type Caller = { id: string; role: string };

// R6: the worker validates with these same frozen schemas (ADR-001), so a payload it would refuse never gets queued.
const PAYLOAD_SCHEMAS: Record<JobKind, ZodType> = {
  claim: claimJobPayloadSchema,
  anchor_assign: anchorAssignJobPayloadSchema,
  estimate: estimateJobPayloadSchema,
  issue: issueJobPayloadSchema,
  set_price: setPriceJobPayloadSchema,
  resolve_flag: resolveFlagJobPayloadSchema,
  score: scoreJobPayloadSchema,
  attestation: attestationJobPayloadSchema,
};

export type EnqueueInput = {
  kind: JobKind;
  /** Built by the server, never taken from a request body (R8). */
  payload: Record<string, unknown>;
  /** Profile id, per jobs §1.3. */
  createdBy: string | null;
  /** The client header or a derived key, per §1.3. */
  idempotencyKey: string | null;
};

/** docs/BE/features/jobs.md §3: the only way a feature creates or re-arms a job. It runs on the caller's transaction,
 *  so the job commits or rolls back with the change it follows (R1). */
export const enqueue = async (
  trx: DatabaseTransaction,
  { kind, payload, createdBy, idempotencyKey }: EnqueueInput,
): Promise<{ job: StoredJob; outcome: EnqueueOutcome }> => {
  const parsed = PAYLOAD_SCHEMAS[kind].safeParse(payload);

  if (!parsed.success) {
    // a server bug, never user input: a plain Error answers 500 internal_error
    throw new Error(`enqueue: invalid ${kind} payload: ${parsed.error.message}`);
  }

  const repository = jobsRepository(trx);
  const validPayload = parsed.data as JobPayload;
  const created = await repository.insertUnlessKeyTaken({
    kind,
    payload: validPayload,
    created_by_profile_id: createdBy,
    idempotency_key: idempotencyKey,
  });

  if (created !== undefined) {
    return { job: created, outcome: 'created' };
  }

  if (idempotencyKey === null) {
    throw new Error('enqueue: an insert without a key returned no row');
  }

  const existing = await repository.lockByKey(idempotencyKey);
  const sameAction =
    existing.kind === kind &&
    (isDerivedKey(idempotencyKey) || existing.created_by_profile_id === createdBy);

  if (!sameAction) {
    throw new DomainError('idempotency_key_reused');
  }

  return existing.status === 'failed'
    ? { job: await repository.rearm(existing.id, validPayload), outcome: 'rearmed' }
    : { job: existing, outcome: 'replayed' };
};

/** jobs §4: slots held by claims (or anchor assignments) the chain has not answered yet. Works on a client or a
 *  transaction. */
export const openSlotCounts = async (
  database: DatabaseClient,
  kind: 'claim' | 'anchor_assign',
  campaign: string,
  planter: string | null,
): Promise<{ total: number; own: number; ownLatestJobId: string | null }> => {
  const counts = await jobsRepository(database).openSlotCounts(kind, campaign, planter);

  return { total: counts.total, own: counts.own, ownLatestJobId: counts.own_latest_id };
};

/** docs/BE/features/jobs.md §2: the creator or an operator reads a job; for anyone else it does not exist. */
export const createJobsService = ({ repository }: { repository: JobsRepository }) => ({
  jobFor: async (caller: Caller, id: string): Promise<JobRow> => {
    const job = await repository.byId(id);

    // by profile id, not role: a donor who created a claim as a planter still reads it (REG-004)
    if (
      job === undefined ||
      (caller.role !== 'operator' && job.created_by_profile_id !== caller.id)
    ) {
      throw new DomainError('not_found');
    }

    return job;
  },
});
