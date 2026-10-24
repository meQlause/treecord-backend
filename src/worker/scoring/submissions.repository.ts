// The submission rows and relayer jobs the scorer and attester read and write (ADR-001: the worker's statements,
// unchanged). Row shapes follow the worker's database parsers: bigint ids as numbers, timestamps as ISO strings.
import type { EvidenceKind, PolicyDecision } from '../../generated/db.js';
import {
  maybeOne,
  one,
  PipelineDbError,
  query,
  setClause,
  UNIQUE_VIOLATION,
  type Json,
  type Queryable,
  type RelayerJobKind,
  type SubmissionStatus,
} from '../worker-db.repository.js';

/** Submission columns, with the uint256 nonce cast to text (exact) and the numeric duration to a number. */
/** The first parameter after the id and the allowed statuses. */
const FIRST_CHANGE_PARAM = 3;

const SUBMISSION_COLUMNS =
  'id, profile_id, device_id, campaign_address, slot_id, tree_id, kind, milestone, video_path, video_sha256, ' +
  'size_bytes, duration_sec::float8, payload, canonical, signature, evidence_hash, captured_at, received_at, status, ' +
  'reject_reasons, ai_response, keyframe_paths, policy_decision, policy_score, attestation, ' +
  'attestation_nonce::text, challenge_id, tx_hash, error, reviewed_by_profile_id, review_note, reviewed_at, ' +
  'created_at, updated_at';

export type SubmissionRow = {
  id: string;
  profile_id: string;
  device_id: string | null;
  campaign_address: string;
  slot_id: number | null;
  tree_id: number | null;
  kind: EvidenceKind;
  milestone: number;
  video_path: string | null;
  video_sha256: string;
  size_bytes: number | null;
  duration_sec: number | null;
  payload: Json | null;
  canonical: string | null;
  signature: string | null;
  evidence_hash: string | null;
  captured_at: string | null;
  received_at: string;
  status: SubmissionStatus;
  reject_reasons: string[];
  ai_response: Json | null;
  keyframe_paths: string[];
  policy_decision: PolicyDecision | null;
  policy_score: number | null;
  attestation: Json | null;
  attestation_nonce: string | null;
  challenge_id: string | null;
  tx_hash: string | null;
  error: string | null;
  reviewed_by_profile_id: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The columns a transition may change. */
export type SubmissionChanges = Partial<
  Pick<
    SubmissionRow,
    | 'status'
    | 'reject_reasons'
    | 'ai_response'
    | 'keyframe_paths'
    | 'policy_decision'
    | 'policy_score'
    | 'attestation'
    | 'reviewed_by_profile_id'
    | 'review_note'
    | 'reviewed_at'
    | 'error'
    | 'tx_hash'
  > & { attestation_nonce: string | number | null }
>;

export type { SubmissionStatus };

export const loadSubmission = (database: Queryable, id: string): Promise<SubmissionRow | null> =>
  maybeOne<SubmissionRow>(
    database,
    'load submission',
    `select ${SUBMISSION_COLUMNS} from public.submissions where id = $1`,
    [id],
  );

/**
 * Updates a submission only while it is in one of `from`. Returns the updated row, or null when the submission had
 * already moved on (another request or job got there first).
 */
export const transitionSubmission = (
  database: Queryable,
  id: string,
  from: SubmissionStatus[],
  changes: SubmissionChanges,
): Promise<SubmissionRow | null> => {
  const set = setClause(changes, FIRST_CHANGE_PARAM);

  return maybeOne<SubmissionRow>(
    database,
    'update submission',
    `update public.submissions set ${set.sql}
     where id = $1 and status = any($2::public.submission_status[])
     returning ${SUBMISSION_COLUMNS}`,
    [id, from, ...set.values],
  );
};

/** Inserts a relayer job under a natural idempotency key, or returns the job already created with that key. */
export const ensureJob = async (
  database: Queryable,
  {
    kind,
    payload,
    idempotencyKey,
    profileId,
  }: {
    kind: RelayerJobKind;
    payload: { [key: string]: Json };
    idempotencyKey: string;
    profileId: string | null;
  },
): Promise<string> => {
  try {
    const inserted = await one<{ id: string }>(
      database,
      'insert relayer job',
      `insert into public.relayer_jobs (kind, payload, idempotency_key, created_by_profile_id)
       values ($1, $2, $3, $4) returning id`,
      [kind, payload, idempotencyKey, profileId],
    );

    return inserted.id;
  } catch (error) {
    if (!(error instanceof PipelineDbError) || error.pgError.code !== UNIQUE_VIOLATION) {
      throw error;
    }

    const existing = await one<{ id: string }>(
      database,
      'load existing job',
      'select id from public.relayer_jobs where idempotency_key = $1',
      [idempotencyKey],
    );

    return existing.id;
  }
};

/** Idempotency key of the attestation job for a submission. */
export const attestationJobKey = (submissionId: string): string => `attestation:${submissionId}`;

/** The campaign's species, for the AI request. */
export const loadCampaignSpecies = (
  database: Queryable,
  campaign: string,
): Promise<{ species_name: string | null; species_code: string | null }> =>
  one(
    database,
    'load campaign',
    'select species_name, species_code from public.campaigns where address = $1',
    [campaign],
  );

export type TreeForScoring = {
  tree_id: number;
  slot_id: number;
  campaign_address: string;
  planted_at: string;
};

export const loadTreeForScoring = (database: Queryable, treeId: number): Promise<TreeForScoring> =>
  one<TreeForScoring>(
    database,
    'load tree',
    'select tree_id, slot_id, campaign_address, planted_at from public.trees where tree_id = $1',
    [treeId],
  );

/** Keyframe paths of the tree's earlier accepted submissions (its planting included), newest first. */
export const loadPreviousKeyframePaths = async (
  database: Queryable,
  submissionId: string,
  tree: TreeForScoring,
  limit: number,
): Promise<string[]> => {
  const rows = await query<{ keyframe_paths: string[] }>(
    database,
    'load previous keyframes',
    `select keyframe_paths, captured_at from public.submissions
     where id <> $1 and status in ('attested', 'onchain')
       and (tree_id = $2 or (kind = 'PLANTED' and campaign_address = $3 and slot_id = $4))
     order by captured_at desc
     limit $5`,
    [submissionId, tree.tree_id, tree.campaign_address, tree.slot_id, limit],
  );

  return rows.flatMap((row) => row.keyframe_paths).slice(0, limit);
};

export const loadPlanterWallet = async (
  database: Queryable,
  profileId: string,
): Promise<string | null> =>
  (
    await one<{ wallet_address: string | null }>(
      database,
      'load planter wallet',
      'select wallet_address from public.profiles where id = $1',
      [profileId],
    )
  ).wallet_address;

/** Marks the challenge a submission answered as fulfilled, once. */
export const fulfilChallenge = async (
  database: Queryable,
  submissionId: string,
  challengeId: string,
): Promise<void> => {
  await query(
    database,
    'fulfil challenge',
    `update public.challenges set fulfilled_submission_id = $1
     where id = $2 and fulfilled_submission_id is null`,
    [submissionId, challengeId],
  );
};

/** Stores a re-signed attestation while the submission still holds `expiredNonce`; false when it moved on. */
export const storeResignedAttestation = async (
  database: Queryable,
  submissionId: string,
  record: { attestation: { nonce: string } },
  expiredNonce: string,
): Promise<boolean> => {
  // uint256 nonces are compared and written as decimal strings
  const updated = await query(
    database,
    'store re-signed attestation',
    `update public.submissions set attestation = $1, attestation_nonce = $2
     where id = $3 and status = 'attested' and attestation_nonce = $4
     returning id`,
    [record, record.attestation.nonce, submissionId, expiredNonce],
  );

  return updated.length > 0;
};

export const replaceJobPayload = async (
  database: Queryable,
  idempotencyKey: string,
  payload: { [key: string]: Json },
): Promise<void> => {
  await query(
    database,
    'update attestation job',
    'update public.relayer_jobs set payload = $1 where idempotency_key = $2',
    [payload, idempotencyKey],
  );
};
