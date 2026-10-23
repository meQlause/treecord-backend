import { DomainError, type ErrorCode } from '../errors.js';

// docs/error-handling.md §2.1: a database violation becomes a domain error by constraint or index name, never by
// SQLSTATE alone (23514 is shared by triggers and every plain CHECK).
const BY_CONSTRAINT: Readonly<Record<string, ErrorCode>> = {
  challenges_one_open_per_tree: 'challenge_active', // 23P01, FR-198
};

/** The domain error a PostgreSQL violation stands for, or undefined when it is not one the API expects. */
export const toDomainError = (error: unknown): DomainError | undefined => {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  const code = typeof constraint === 'string' ? BY_CONSTRAINT[constraint] : undefined;

  return code === undefined ? undefined : new DomainError(code);
};
