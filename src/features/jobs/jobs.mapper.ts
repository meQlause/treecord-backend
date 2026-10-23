import type { JobRow } from './jobs.repository.js';

/** docs/BE/features/jobs.md §2 response. `lastError` is a raw worker message: the key exists for operators only
 *  (NFR-055). The raw payload never leaves the server. */
export const toJobDto = (row: JobRow, { withLastError }: { withLastError: boolean }) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  attempts: row.attempts,
  txHash: row.tx_hash,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  context: {
    campaign: row.context_campaign,
    treeId: row.context_tree_id,
    batchId: row.context_batch_id,
    submissionId: row.context_submission_id,
  },
  ...(withLastError ? { lastError: row.last_error } : {}),
});
