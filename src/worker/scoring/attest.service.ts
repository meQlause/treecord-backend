// Turns an accepted submission into a signed attestation and a queued relayer job, after a passing score.
import type { Address, Hex } from 'viem';
import type { Attester, SignedAttestationRecord } from '../../generated/frozen/attester.js';
import { GEOHASH_PRECISION } from '../../generated/frozen/constants.js';
import { encodeGeohash, geohashToBytes8 } from '../../generated/frozen/evidence.js';
import type { EvidencePayload } from '../../generated/frozen/evidence.js';
import {
  PipelineDbError,
  UNIQUE_VIOLATION,
  type Db,
  type Json,
  type Queryable,
} from '../worker-db.repository.js';
import {
  attestationJobKey,
  ensureJob,
  fulfilChallenge,
  loadPlanterWallet,
  loadSubmission,
  replaceJobPayload,
  storeResignedAttestation,
  transitionSubmission,
  type SubmissionRow,
  type SubmissionStatus,
} from './submissions.repository.js';

export type AttestDeps = {
  db: Db;
  attester: Attester;
  /** Current chain time in seconds. Attestation expiry is based on it. */
  chainNow: () => Promise<number>;
};

export type AttestOutcome =
  | { status: 'attested'; jobId: string; submission: SubmissionRow }
  | { status: Exclude<SubmissionStatus, 'attested'>; jobId: null; submission: SubmissionRow };

const mustLoad = async (database: Queryable, id: string): Promise<SubmissionRow> => {
  const row = await loadSubmission(database, id);

  if (!row) {
    throw new Error(`Submission ${id} disappeared`);
  }

  return row;
};

const jobPayload = (
  submissionId: string,
  record: SignedAttestationRecord,
): { [key: string]: Json } => ({
  submissionId,
  nonce: record.attestation.nonce,
  attestation: record.attestation as unknown as Json,
  signature: record.signature,
});

/** Makes sure an attested submission has its relayer job. Idempotent per submission. */
export const ensureAttestationJob = async (
  database: Queryable,
  submission: SubmissionRow,
): Promise<{ status: 'attested'; jobId: string; submission: SubmissionRow }> => {
  const record = submission.attestation as unknown as SignedAttestationRecord | null;

  if (!record) {
    throw new Error(`Submission ${submission.id} is attested but has no attestation`);
  }

  const jobId = await ensureJob(database, {
    kind: 'attestation',
    payload: jobPayload(submission.id, record),
    idempotencyKey: attestationJobKey(submission.id),
    profileId: submission.profile_id,
  });

  return { status: 'attested', jobId, submission };
};

const signFor = async (
  deps: AttestDeps,
  submission: SubmissionRow,
): Promise<SignedAttestationRecord> => {
  const payload = submission.payload as unknown as EvidencePayload | null;

  if (!payload || !submission.evidence_hash || submission.policy_score === null) {
    throw new Error(
      `Submission ${submission.id} is missing payload, evidence hash or policy score`,
    );
  }

  const wallet = await loadPlanterWallet(deps.db, submission.profile_id);

  if (!wallet) {
    throw new Error(`Planter of ${submission.id} has no wallet`);
  }

  return deps.attester.sign(
    {
      kind: submission.kind,
      campaign: submission.campaign_address as Address,
      slotId: BigInt(submission.slot_id ?? 0),
      treeId: BigInt(submission.tree_id ?? 0),
      planter: wallet as Address,
      milestone: submission.milestone,
      evidenceHash: submission.evidence_hash as Hex,
      geohash: geohashToBytes8(encodeGeohash(payload.lat, payload.lon, GEOHASH_PRECISION)),
      score: submission.policy_score,
    },
    await deps.chainNow(),
  );
};

/**
 * Another submission for the same tree milestone (or slot planting) was accepted first: the partial unique indexes
 * refused the transition, so this one is rejected with milestone_already_done.
 */
const rejectAsDuplicate = async (
  deps: AttestDeps,
  submission: SubmissionRow,
  from: SubmissionStatus[],
): Promise<AttestOutcome> => {
  const rejected = await transitionSubmission(deps.db, submission.id, from, {
    status: 'rejected',
    reject_reasons: [...submission.reject_reasons, 'milestone_already_done'],
  });
  const current = rejected ?? (await mustLoad(deps.db, submission.id));

  if (current.status === 'attested') {
    return ensureAttestationJob(deps.db, current);
  }

  return { status: current.status, jobId: null, submission: current };
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof PipelineDbError && error.pgError.code === UNIQUE_VIOLATION;

/**
 * Signs an attestation for a submission in one of `from`, stores it, moves the submission to `attested`, and
 * enqueues the `attestation` relayer job. Safe to call again for an attested submission: it only makes sure the
 * job exists.
 */
export const attestSubmission = async (
  deps: AttestDeps,
  submission: SubmissionRow,
  from: SubmissionStatus[],
): Promise<AttestOutcome> => {
  if (submission.status === 'attested') {
    return ensureAttestationJob(deps.db, submission);
  }

  const record = await signFor(deps, submission);
  let updated: SubmissionRow | null;

  try {
    updated = await transitionSubmission(deps.db, submission.id, from, {
      status: 'attested',
      attestation: record as unknown as Json,
      // uint256 column, written as a decimal string
      attestation_nonce: record.attestation.nonce,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    return rejectAsDuplicate(deps, submission, from);
  }

  const current = updated ?? (await mustLoad(deps.db, submission.id));

  if (current.status !== 'attested') {
    return { status: current.status, jobId: null, submission: current };
  }

  if (current.challenge_id) {
    await fulfilChallenge(deps.db, current.id, current.challenge_id);
  }

  return ensureAttestationJob(deps.db, current);
};

/**
 * Re-signs an attested submission whose attestation expired before it reached the chain, with a fresh nonce and
 * expiry, and points its relayer job at the new signature. An expired attestation can never be accepted (the
 * gateway checks block.timestamp > expiry), so replacing it cannot cause a double submission. Returns null when the
 * submission no longer holds `expiredNonce` (another worker re-signed it).
 */
export const resignAttestation = async (
  deps: AttestDeps,
  submission: SubmissionRow,
  expiredNonce: string,
): Promise<{ record: SignedAttestationRecord; submission: SubmissionRow } | null> => {
  const record = await signFor(deps, submission);

  if (!(await storeResignedAttestation(deps.db, submission.id, record, expiredNonce))) {
    return null;
  }

  await replaceJobPayload(
    deps.db,
    attestationJobKey(submission.id),
    jobPayload(submission.id, record),
  );

  return { record, submission: await mustLoad(deps.db, submission.id) };
};
