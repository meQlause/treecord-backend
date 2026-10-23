import { sql } from 'kysely';
import request from 'supertest';
import { recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import { VALID_ENV } from '../../../fixtures/env.js';
import {
  ALEX,
  IN_REVIEW_ID,
  RAKA,
  ROOTS,
  rootsThatStay,
  SARI,
  SARI_WALLET,
} from '../../../fixtures/roots-that-stay.js';

// tree 3001's month-6 check-in, rejected below; tree 3104's month-3 one, whose window closed before chain time
const TO_REJECT = '6d2a9c4e-1b7f-4e3a-8c5d-0f9e2b4a7c61';
const WINDOW_CLOSED = '7e3b0d5f-2c8a-4f4b-9d6e-1a0f3c5b8d72';
const NOTE = 'Seedling clearly visible, camera shake explains liveness.';
// chain time 2026-10-23T03:12:44Z (tests/helpers/api.ts) plus the one-hour attestation lifetime (FR-158)
const EXPIRY = String(Date.parse('2026-10-23T03:12:44Z') / 1000 + 3600);
const EVIDENCE_HASH = `0x${'e'.repeat(64)}`;

let test: TestDatabase;
let api: TestApi;

const review = async (submissionId: string, body: object, userId = RAKA) =>
  request(api.app)
    .post(`/api/v1/operator/submissions/${submissionId}/review`)
    .set(await api.signedIn(userId))
    .send(body);

const stored = async (submissionId: string) => {
  const [row] = (
    await sql<{
      status: string;
      attestation: { attestation: Record<string, unknown>; digest: Hex; signature: Hex };
      attestation_nonce: string;
      review_note: string | null;
      reviewer: string | null;
    }>`select s.status, s.attestation, s.attestation_nonce::text, s.review_note, p.privy_user_id as reviewer
      from public.submissions s left join public.profiles p on p.id = s.reviewed_by_profile_id
      where s.id = ${submissionId}`.execute(test.database)
  ).rows;

  if (row === undefined) {
    throw new Error(`no submission ${submissionId}`);
  }

  return row;
};

const attestationJob = async (submissionId: string) => {
  const key = `attestation:${submissionId}`;

  return (
    await sql<{
      payload: Record<string, unknown>;
      creator: string;
    }>`select j.payload, p.privy_user_id as creator from public.relayer_jobs j
      join public.profiles p on p.id = j.created_by_profile_id
      where j.idempotency_key = ${key}`.execute(test.database)
  ).rows;
};

// a needs_review check-in by Sari, signed at the Banyumas point, with its hash and policy score
const inReview = async (id: string, treeId: number, milestone: number) => {
  await sql`insert into public.submissions (id, profile_id, campaign_address, kind, milestone, tree_id, video_sha256,
      status, reject_reasons, policy_score, evidence_hash, payload)
    select ${id}, p.id, ${ROOTS}, 'ALIVE', ${milestone}, ${treeId}, ${id.replaceAll('-', '').padEnd(64, '0')},
      'needs_review', ${['liveness_borderline']}, 7400, ${EVIDENCE_HASH}, ${JSON.stringify({ lat: -7.431205, lon: 109.247813 })}::jsonb
    from public.profiles p where p.privy_user_id = ${SARI}`.execute(test.database);
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await rootsThatStay(test.database);
  await sql`update public.submissions set policy_score = 7400, evidence_hash = ${EVIDENCE_HASH},
      payload = ${JSON.stringify({ lat: -7.431205, lon: 109.247813 })}::jsonb
    where id = ${IN_REVIEW_ID}`.execute(test.database);
  await inReview(TO_REJECT, 3001, 2);
  await inReview(WINDOW_CLOSED, 3104, 1);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/evidence.md §5, FR-156, FR-158.
describe('POST /api/v1/operator/submissions/:submissionId/review approve', () => {
  it('signs the attestation for tree 3104 month 6 and queues attestation:<id> for the submitter: 202 { job }', async () => {
    const response = await review(IN_REVIEW_ID, { approve: true, note: ` ${NOTE} ` });
    const row = await stored(IN_REVIEW_ID);
    const record = row.attestation;

    expect(response.status).toBe(202);
    expect(response.body.job).toMatchObject({ kind: 'attestation', status: 'pending' });
    expect(row).toMatchObject({ status: 'attested', review_note: NOTE, reviewer: RAKA });
    expect(record.attestation).toMatchObject({
      kind: 1,
      campaign: ROOTS,
      slotId: '0',
      treeId: '3104',
      planter: SARI_WALLET,
      milestone: 2,
      evidenceHash: EVIDENCE_HASH,
      score: 7400,
      nonce: row.attestation_nonce,
      expiry: EXPIRY,
    });
    expect(await recoverAddress({ hash: record.digest, signature: record.signature })).toBe(
      privateKeyToAccount(VALID_ENV.ATTESTER_PRIVATE_KEY as Hex).address,
    );
    expect(await attestationJob(IN_REVIEW_ID)).toEqual([
      {
        payload: {
          submissionId: IN_REVIEW_ID,
          nonce: row.attestation_nonce,
          attestation: record.attestation,
          signature: record.signature,
        },
        creator: SARI,
      },
    ]);
  });

  it('the same decision again answers 200 with that job; the other answers 409 not_in_review', async () => {
    const again = await review(IN_REVIEW_ID, { approve: true, note: 'Again' });
    const other = await review(IN_REVIEW_ID, { approve: false, note: 'Changed my mind' });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ idempotent: true, job: { kind: 'attestation' } });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatchObject({
      code: 'not_in_review',
      details: { status: 'attested' },
    });
    expect((await stored(IN_REVIEW_ID)).review_note).toBe(NOTE);
  });

  it('a check-in whose window closed in chain time answers 409 cannot_attest; reject stays possible', async () => {
    const approve = await review(WINDOW_CLOSED, { approve: true, note: NOTE });
    const reject = await review(WINDOW_CLOSED, { approve: false, note: 'Window closed' });

    expect(approve.status).toBe(409);
    expect(approve.body.error).toMatchObject({
      code: 'cannot_attest',
      details: { reasons: ['milestone_not_open'] },
    });
    expect(await attestationJob(WINDOW_CLOSED)).toEqual([]);
    expect(reject.status).toBe(200);
  });
});

describe('POST /api/v1/operator/submissions/:submissionId/review reject', () => {
  it('answers 200 with the submission: rejected, the policy reasons then operator_rejected, and the review', async () => {
    const response = await review(TO_REJECT, { approve: false, note: 'Seedling not in frame.' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: TO_REJECT,
      status: 'rejected',
      rejectReasons: ['liveness_borderline', 'operator_rejected'],
      review: {
        note: 'Seedling not in frame.',
        reviewedAt: expect.any(String),
        decision: 'rejected',
      },
    });
    expect(await attestationJob(TO_REJECT)).toEqual([]);
  });

  it('the same decision again is idempotent; approving it now answers 409 not_in_review', async () => {
    const again = await review(TO_REJECT, { approve: false, note: 'Again' });
    const approve = await review(TO_REJECT, { approve: true, note: NOTE });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: TO_REJECT, idempotent: true });
    expect(approve.body.error).toMatchObject({
      code: 'not_in_review',
      details: { status: 'rejected' },
    });
  });

  it.each([
    {
      name: 'an unknown submission',
      id: '7d5c9b8e-1f4a-4c2e-9a3b-6f0e2d1c4b5a',
      status: 404,
      code: 'not_found',
    },
    { name: 'a malformed id', id: '7d5c9b8e', status: 400, code: 'invalid_path' },
    {
      name: 'a blank note',
      body: { approve: false, note: '   ' },
      status: 400,
      code: 'validation_error',
    },
    { name: 'no decision', body: { note: NOTE }, status: 400, code: 'validation_error' },
    { name: 'a donor', userId: ALEX, status: 403, code: 'forbidden_role' },
    { name: 'the planter herself', userId: SARI, status: 403, code: 'forbidden_role' },
  ])(
    '$name answers $status $code',
    async ({
      id = TO_REJECT,
      body = { approve: false, note: NOTE },
      userId = RAKA,
      status,
      code,
    }) => {
      const response = await review(id, body, userId);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});
