import { query, setClause, type Json, type Queryable } from '../worker-db.repository.js';
import type { JobKind, JobStatus, JobUpdate } from './state.rules.js';

/** A relayer_jobs row as claim_relayer_jobs returns it. */
export type Job = {
  id: string;
  kind: JobKind;
  payload: Json;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  tx_hash: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  created_by_profile_id: string | null;
  locked_at: string | null;
  locked_by: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
};

/** Claims up to `limit` due jobs of `kinds` for this worker; p_stale_after keeps its default. */
export const claimJobs = (
  database: Queryable,
  kinds: JobKind[],
  limit: number,
  workerId: string,
): Promise<Job[]> =>
  query<Job>(
    database,
    'claim_relayer_jobs',
    'select * from public.claim_relayer_jobs($1::public.relayer_job_kind[], $2, $3)',
    [kinds, limit, workerId],
  );

const lockColumns = (lock: JobUpdate['lock'], now: Date): Record<string, unknown> => {
  if (lock === 'release') {
    return { locked_at: null, locked_by: null };
  }

  return lock === 'refresh' ? { locked_at: now.toISOString() } : {};
};

/** Writes a JobUpdate; its relative retry and lock become timestamps of `now`. */
export const updateJob = async (
  database: Queryable,
  jobId: string,
  update: JobUpdate,
  now: Date,
): Promise<void> => {
  const { retryInMs, lock, ...columns } = update;
  const set = setClause(
    {
      ...columns,
      ...(retryInMs === undefined
        ? {}
        : { next_attempt_at: new Date(now.getTime() + retryInMs).toISOString() }),
      ...lockColumns(lock, now),
    },
    2,
  );

  await query(
    database,
    'update relayer job',
    `update public.relayer_jobs set ${set.sql} where id = $1`,
    [jobId, ...set.values],
  );
};

/** The attestation's tx hash is shown on its submissions while it is in flight. */
export const recordAttestationTx = async (
  database: Queryable,
  submissionIds: string[],
  hash: string,
): Promise<void> => {
  await query(
    database,
    'record attestation tx',
    "update public.submissions set tx_hash = $1 where id = any($2::uuid[]) and status = 'attested'",
    [hash, submissionIds],
  );
};
