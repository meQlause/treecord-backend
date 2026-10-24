// Relayer job state transitions. Pure: the relayer computes the update here and the repository writes it.
//
//   pending ──claim──▶ processing ──send──▶ sent ──receipt ok──▶ confirmed
//      ▲                   │                 │
//      └──── retry with ───┴──── revert, ────┘
//            backoff           error or timeout
//                              (failed after max_attempts, or at once for permanent errors)
//
// claim_relayer_jobs counts each claim as an attempt and reclaims jobs left in processing or sent by a crashed
// worker. A job that already has a tx hash checks its receipt before sending anything again.

export type JobStatus = 'pending' | 'processing' | 'sent' | 'confirmed' | 'failed';

export type JobKind =
  | 'score'
  | 'attestation'
  | 'claim'
  | 'anchor_assign'
  | 'estimate'
  | 'issue'
  | 'set_price'
  | 'resolve_flag';

/**
 * The change to one job. `retryInMs` becomes next_attempt_at (that long after now); `lock` "release" clears
 * locked_at and locked_by, "refresh" sets locked_at to now (the job stays locked while its receipt is awaited).
 */
export type JobUpdate = {
  status: JobStatus;
  last_error?: string | null;
  tx_hash?: string;
  retryInMs?: number;
  lock?: 'release' | 'refresh';
};

const RETRY_BASE_MS = 15_000;

const RETRY_MAX_MS = 600_000;

const MAX_ERROR_LENGTH = 1_000;

/** Delay before retry number `attempt` (1-based): 15 s, 30 s, 60 s, 120 s, ... capped at 10 minutes. */
const retryDelayMs = (attempt: number, baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS): number =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

/**
 * Contract errors that will not change by retrying, so the job fails at once. Everything else (RPC errors,
 * timeouts, windows not yet open, flagged trees, unknown reverts) is retried with backoff.
 */
const PERMANENT_REVERTS = new Set([
  'Unauthorized',
  'AccessControlUnauthorizedAccount',
  'ZeroAddress',
  'ZeroAmount',
  'InvalidSignature',
  'InvalidAttester',
  'InvalidAttestationKind',
  'InvalidScore',
  'InvalidPlantedAttestation',
  'TreeCampaignMismatch',
  'WrongPlanter',
  'MilestoneAlreadySettled',
  'InvalidMilestone',
  'SlotAlreadyPlanted',
  'SlotNotOwned',
  'InvalidSlot',
  'NotEnoughSlots',
  'PlanterCapExceeded',
  'ClaimWindowClosed',
  'WrongCampaignStatus',
  'UnknownCampaign',
  'UnknownTree',
  'TreeNotInCampaign',
  'ReplantDeadlinePassed',
  'EstimateLocked',
  'UnknownBatch',
  'LengthMismatch',
]);

export type Failure = 'transient' | 'permanent';

const ATTESTATION_VERDICTS: Record<string, 'already_done' | 'expired'> = {
  NonceAlreadyUsed: 'already_done',
  AttestationExpired: 'expired',
};

/** What a simulation revert means for a job of `kind`. */
export const classifyRevert = (
  kind: JobKind,
  errorName: string | null,
): 'already_done' | 'expired' | Failure => {
  const attestationVerdict =
    kind === 'attestation' && errorName !== null ? ATTESTATION_VERDICTS[errorName] : undefined;

  if (attestationVerdict) {
    return attestationVerdict;
  }

  return errorName !== null && PERMANENT_REVERTS.has(errorName) ? 'permanent' : 'transient';
};

/** After a failed attempt: retry later, or fail for good when attempts are used up or the error is permanent. */
export const afterFailure = (
  job: { attempts: number; max_attempts: number },
  failure: Failure,
  message: string,
): JobUpdate => {
  const lastError = message.slice(0, MAX_ERROR_LENGTH);

  if (failure === 'permanent' || job.attempts >= job.max_attempts) {
    return { status: 'failed', last_error: lastError, lock: 'release' };
  }

  return {
    status: 'pending',
    last_error: lastError,
    retryInMs: retryDelayMs(job.attempts),
    lock: 'release',
  };
};

/** A transaction was broadcast. The job stays locked while the relayer waits for the receipt. */
export const afterSent = (txHash: string): JobUpdate => ({
  status: 'sent',
  tx_hash: txHash,
  lock: 'refresh',
});

/**
 * Check again shortly without treating it as a failure, for example when the receipt did not arrive in time. The tx
 * hash is kept, so the next attempt checks it before sending again.
 */
export const afterReceiptTimeout = (
  delayMs = RETRY_BASE_MS,
  reason = 'receipt not seen yet',
): JobUpdate => ({ status: 'pending', last_error: reason, retryInMs: delayMs, lock: 'release' });

/** Done. `txHash` is null when the work was already on-chain (for example a used attestation nonce). */
export const afterConfirmed = (txHash: string | null): JobUpdate => ({
  status: 'confirmed',
  last_error: null,
  ...(txHash ? { tx_hash: txHash } : {}),
  lock: 'release',
});
