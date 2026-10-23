import { describe, expect, it } from 'vitest';
import { parseIdempotencyKey } from '../../../../src/features/jobs/jobs.rules.js';
import { DomainError } from '../../../../src/shared/errors.js';

// docs/BE/features/jobs.md §3.2 R10, README §7.
describe('parseIdempotencyKey', () => {
  it('no header means no key', () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
  });

  it.each(['d06-7f3c1e52-claim-2', 'x', '!'.repeat(200), 'claim:abc', '~a1'])(
    'accepts %s',
    (key) => {
      expect(parseIdempotencyKey(key)).toBe(key);
    },
  );

  it.each([
    ['empty', ''],
    ['201 characters', 'k'.repeat(201)],
    ['a space', 'claim 2'],
    ['a tab', 'claim\t2'],
    ['non-ASCII', 'klaim-é'],
    ['the score prefix', 'score:7c1e4a9d'],
    ['the attestation prefix', 'attestation:7c1e4a9d'],
    ['the resolve_flag prefix', 'resolve_flag:3091'],
  ])('refuses %s with invalid_idempotency_key', (_case, key) => {
    expect(() => parseIdempotencyKey(key)).toThrow(
      expect.objectContaining({ code: 'invalid_idempotency_key' }) as DomainError,
    );
  });
});
