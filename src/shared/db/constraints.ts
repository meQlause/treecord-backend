import { DomainError, type ErrorCode, type ErrorDetails } from '../errors.js';

// docs/error-handling.md §2.1: a database violation becomes a domain error by constraint or index name, never by
// SQLSTATE alone (23514 is shared by triggers and every plain CHECK). Rows §2.1 calls "not an error" or "retry"
// (profiles_privy_user_id_key, relayer_jobs_idempotency_key_key, flags_one_pending_per_flagger_idx, slot_tags) are
// handled by their feature's service; anything unmapped is a bug and answers 500 internal_error.
type Mapped = { code: ErrorCode; details?: ErrorDetails };

// FR-138 indexes carry a precheck reason inside precheck_failed, never a code of their own (error-handling §3 note).
const precheck = (reason: string): Mapped => ({
  code: 'precheck_failed',
  details: { reasons: [reason] },
});

// The API validates these fields first; the constraint only answers a request that slipped past it.
const invalid = (path: string, message: string): Mapped => ({
  code: 'validation_error',
  details: [{ path, message }],
});

const BY_CONSTRAINT: Readonly<Record<string, Mapped>> = {
  challenges_one_open_per_tree: { code: 'challenge_active' }, // 23P01, FR-198
  submissions_one_live_check_in_idx: precheck('milestone_already_done'), // 23505, FR-138
  submissions_one_per_milestone_idx: precheck('milestone_already_done'),
  submissions_one_live_planting_idx: precheck('slot_already_planted'),
  submissions_one_planting_per_slot_idx: precheck('slot_already_planted'),
  submissions_one_inflight_event_idx: precheck('already_reported'),
  // the same owner re-sending a still-queued video gets the existing submission; that is the evidence service's job
  submissions_video_sha256_key: precheck('duplicate_video'), // 23505, FR-132
  devices_thumbprint_key: { code: 'device_already_registered' }, // 23505, FR-120
  profiles_wallet_address_key: { code: 'wallet_already_linked' }, // 23505, FR-003
  planters_accept_carbon_agreement: { code: 'agreement_required' }, // 23514, FR-021
  devices_label_required: invalid('label', 'Required'), // 23514, FR-120
  public_p256_key_only: invalid('publicKey', 'Must be a public P-256 key'), // 23514, NFR-001
};

// Triggers raise check_violation (23514) with the code as their message (data-spec §6.2, the frozen device limit).
const CHECK_VIOLATION = '23514';
const BY_TRIGGER_MESSAGE: Readonly<Record<string, Mapped>> = {
  session_closed: { code: 'session_closed' }, // FR-197, FR-198, FR-200
  device_limit_reached: { code: 'device_limit_reached', details: { max: 3 } }, // FR-120, the trigger's limit
};

type PostgresError = { code?: unknown; constraint?: unknown; message?: unknown } | null;

const lookup = (error: PostgresError): Mapped | undefined => {
  if (typeof error?.constraint === 'string') {
    return BY_CONSTRAINT[error.constraint];
  }

  return error?.code === CHECK_VIOLATION && typeof error.message === 'string'
    ? BY_TRIGGER_MESSAGE[error.message]
    : undefined;
};

/** The domain error a PostgreSQL violation stands for, or undefined when it is not one the API expects. */
export const toDomainError = (error: unknown): DomainError | undefined => {
  const mapped = lookup(error as PostgresError);

  return mapped === undefined ? undefined : new DomainError(mapped.code, mapped.details);
};
