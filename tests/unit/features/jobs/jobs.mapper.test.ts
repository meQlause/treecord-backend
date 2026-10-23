import { describe, expect, it } from 'vitest';
import { enqueuedResponse } from '../../../../src/features/jobs/jobs.mapper.js';

const ROW = {
  id: '3b1e0c8a-6f2d-4a9b-8c7e-1d5f4a2b9e60',
  kind: 'claim',
  status: 'pending',
  attempts: 0,
  tx_hash: null,
  created_at: new Date('2026-10-23T03:12:44.512Z'),
  updated_at: new Date('2026-10-23T03:12:44.512Z'),
  created_by_profile_id: '00000000-0000-0000-0000-000000000001',
  idempotency_key: 'd06-7f3c1e52-claim-2',
  last_error: null,
  locked_at: null,
  locked_by: null,
  max_attempts: 5,
  next_attempt_at: new Date('2026-10-23T03:12:44.512Z'),
  payload: {},
} as const;

// README §7's Job, with no payload, key or worker columns.
const JOB = {
  id: '3b1e0c8a-6f2d-4a9b-8c7e-1d5f4a2b9e60',
  kind: 'claim',
  status: 'pending',
  attempts: 0,
  txHash: null,
  createdAt: '2026-10-23T03:12:44.512Z',
  updatedAt: '2026-10-23T03:12:44.512Z',
};

// docs/BE/features/jobs.md §3: what the calling endpoint answers for each outcome.
describe('enqueuedResponse', () => {
  it.each(['created', 'rearmed'] as const)('%s answers 202 with the job', (outcome) => {
    expect(enqueuedResponse({ job: ROW, outcome })).toEqual({ status: 202, body: { job: JOB } });
  });

  it('replayed answers 200 with the job and idempotent: true', () => {
    expect(enqueuedResponse({ job: ROW, outcome: 'replayed' })).toEqual({
      status: 200,
      body: { job: JOB, idempotent: true },
    });
  });
});
