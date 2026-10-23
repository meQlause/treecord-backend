// docs/error-handling.md §3 (status per code) and §4.1 (the sentence). A code has exactly one status and one
// condition; a new condition gets a new code there first (§6). Lorem ipsum marks copy nobody has written yet; its
// COPY-nnn id is the section in docs/FE/copy-recommendations.md.
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
const RETRY = 'Could not load this page · Your inputs and local records are unchanged.';
const SIGN_IN = 'We’ll send a six-digit code to your email. Afterwards you’ll return to {where}.';
const NOT_FOUND = 'Not found · Page not found'; // §5.1 "Any other"; screens show their own title

export const ERROR_REGISTRY = {
  validation_error: { status: 400, message: LOREM }, // COPY-001; screens show the field table's sentence
  invalid_json: { status: 400, message: LOREM }, // COPY-002
  invalid_path: { status: 400, message: NOT_FOUND },
  invalid_cursor: { status: 400, message: 'Couldn’t load more. Your campaigns are still here.' },
  invalid_idempotency_key: { status: 400, message: LOREM }, // COPY-003
  agreement_required: { status: 400, message: LOREM }, // COPY-004
  payload_mismatch: { status: 400, message: LOREM }, // COPY-005
  missing_token: { status: 401, message: SIGN_IN },
  invalid_token: { status: 401, message: SIGN_IN },
  forbidden_role: {
    status: 403,
    message: 'Role unavailable · This screen is for {role} accounts.',
  },
  role_locked: { status: 403, message: LOREM }, // COPY-006
  wallet_missing: {
    status: 403,
    message: 'Your wallet is still being prepared. Try again in a moment.',
  },
  not_contributor: { status: 403, message: LOREM }, // COPY-007
  not_found: { status: 404, message: NOT_FOUND },
  wallet_already_linked: { status: 409, message: LOREM }, // COPY-008
  idempotency_key_reused: { status: 409, message: LOREM }, // COPY-009
  device_limit_reached: { status: 409, message: LOREM }, // COPY-010
  device_already_registered: { status: 409, message: LOREM }, // COPY-011
  campaign_not_active: { status: 409, message: 'Campaign must be Active.' },
  claim_window_closed: { status: 409, message: LOREM }, // COPY-012
  not_enough_slots: { status: 409, message: LOREM }, // COPY-013
  planter_cap_exceeded: {
    status: 409,
    message: 'You can claim at most {remaining} more slots in this campaign',
  },
  not_in_review: { status: 409, message: 'Not waiting for review.' },
  cannot_attest: { status: 409, message: LOREM }, // COPY-014
  tree_not_flaggable: { status: 409, message: LOREM }, // COPY-015
  flag_not_open: { status: 409, message: LOREM }, // COPY-016
  flag_resolution_pending: {
    status: 409,
    message: 'Resolution pending. Review the job before another decision.',
  },
  no_trees: { status: 409, message: 'No trees planted in this campaign yet.' },
  session_closed: { status: 409, message: 'This session is closed.' },
  challenge_active: { status: 409, message: 'This tree already has an open challenge.' },
  tree_not_alive: { status: 409, message: 'Only Alive trees can be challenged.' },
  findings_incomplete: { status: 409, message: 'Still missing a finding: {missing}.' },
  estimate_locked: { status: 409, message: 'Estimate locked after first issuance.' },
  species_unknown: { status: 409, message: LOREM }, // COPY-017
  campaign_not_issuable: { status: 409, message: LOREM }, // COPY-018
  registry_retirement_done: { status: 409, message: LOREM }, // COPY-021
  video_not_uploaded: { status: 409, message: LOREM }, // COPY-019
  precheck_failed: { status: 422, message: 'Rejected by the prechecks. See why.' },
  internal_error: { status: 500, message: RETRY },
  service_unavailable: { status: 503, message: RETRY },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export type ErrorDetails = Readonly<Record<string, unknown>> | readonly unknown[];

/** Thrown by services; the error handler turns it into the §1 envelope. No controller sets a status. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, details?: ErrorDetails) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
