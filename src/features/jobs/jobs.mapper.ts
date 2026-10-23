import type { JobRow, StoredJob } from './jobs.repository.js';

export type EnqueueOutcome = 'created' | 'replayed' | 'rearmed';

/** README §7's Job: what an enqueuing endpoint answers. The raw payload never leaves the server. */
const toJobSummary = (row: StoredJob) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  attempts: row.attempts,
  txHash: row.tx_hash,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** A job another feature shows an operator (flags §2, operations §1): the summary plus the raw worker error, which
 *  only operators ever see (NFR-055). */
export const toOperatorJob = (row: StoredJob) => ({
  ...toJobSummary(row),
  lastError: row.last_error,
});

/** docs/BE/features/jobs.md §2 response. `lastError` is a raw worker message: the key exists for operators only
 *  (NFR-055). */
export const toJobDto = (row: JobRow, { withLastError }: { withLastError: boolean }) => ({
  ...toJobSummary(row),
  context: {
    campaign: row.context_campaign,
    treeId: row.context_tree_id,
    batchId: row.context_batch_id,
    submissionId: row.context_submission_id,
  },
  ...(withLastError ? { lastError: row.last_error } : {}),
});

/** jobs §3: the calling endpoint's answer. A replay is 200 and says so; a new or re-armed job is 202. */
export const enqueuedResponse = ({ job, outcome }: { job: StoredJob; outcome: EnqueueOutcome }) =>
  outcome === 'replayed'
    ? { status: 200, body: { job: toJobSummary(job), idempotent: true } }
    : { status: 202, body: { job: toJobSummary(job) } };
