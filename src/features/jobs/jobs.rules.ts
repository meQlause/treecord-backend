import { DomainError } from '../../shared/errors.js';

// Keys the server derives itself (jobs §1.3); a client may not occupy one (R10).
const DERIVED_PREFIXES = ['score:', 'attestation:', 'resolve_flag:'];
// 1–200 visible ASCII characters (README §7)
const CLIENT_KEY = /^[\x21-\x7e]{1,200}$/;

/** A derived key already names its target (`score:<submissionId>`), so its kind alone decides "the same action". */
export const isDerivedKey = (key: string): boolean =>
  DERIVED_PREFIXES.some((prefix) => key.startsWith(prefix));

/** jobs §3.2 R10: the `Idempotency-Key` header, checked by the route before the body. Absent means no key. */
export const parseIdempotencyKey = (header: string | undefined): string | null => {
  if (header === undefined) {
    return null;
  }

  if (!CLIENT_KEY.test(header) || isDerivedKey(header)) {
    throw new DomainError('invalid_idempotency_key');
  }

  return header;
};
