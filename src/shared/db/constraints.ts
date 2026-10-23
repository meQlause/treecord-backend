import { DomainError, type ErrorCode, type ErrorDetails } from '../errors.js';

// docs/error-handling.md §2.1: a database violation becomes a domain error by constraint or index name, never by
// SQLSTATE alone (23514 is shared by triggers and every plain CHECK).
type Mapped = { code: ErrorCode; details?: ErrorDetails };

// FR-138 indexes carry a precheck reason inside precheck_failed, never a code of their own (error-handling §3 note).
const precheck = (reason: string): Mapped => ({
  code: 'precheck_failed',
  details: { reasons: [reason] },
});

const BY_CONSTRAINT: Readonly<Record<string, Mapped>> = {
  challenges_one_open_per_tree: { code: 'challenge_active' }, // 23P01, FR-198
  submissions_one_live_check_in_idx: precheck('milestone_already_done'), // 23505, FR-138
  submissions_one_per_milestone_idx: precheck('milestone_already_done'),
  submissions_one_live_planting_idx: precheck('slot_already_planted'),
  submissions_one_planting_per_slot_idx: precheck('slot_already_planted'),
  submissions_one_inflight_event_idx: precheck('already_reported'),
};

/** The domain error a PostgreSQL violation stands for, or undefined when it is not one the API expects. */
export const toDomainError = (error: unknown): DomainError | undefined => {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  const mapped = typeof constraint === 'string' ? BY_CONSTRAINT[constraint] : undefined;

  return mapped === undefined ? undefined : new DomainError(mapped.code, mapped.details);
};
