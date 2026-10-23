import type { Address, Hex } from 'viem';
import { GEOHASH_PRECISION } from '../../generated/frozen/constants.js';
import {
  encodeGeohash,
  geohashToBytes8,
  type EvidencePayload,
} from '../../generated/frozen/evidence.js';
import type { createAttester } from '../../shared/chain/attester.js';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { enqueue, enqueuedResponse, jobByKey } from '../jobs/index.js';
import { loadPlanting, loadTree, type Scope, type TreeKind } from './evidence.facts.js';
import {
  evidenceRepository,
  type EvidenceRepository,
  type ReviewRow,
} from './evidence.repository.js';
import { approveChecks, reasonsOf } from './prechecks/prechecks.rules.js';

type Operator = { id: string; role: string };

type Attester = Pick<ReturnType<typeof createAttester>, 'sign'>;

type ReviewDependencies = {
  database: DatabaseClient;
  attester: Attester;
  /** The latest block's time: the re-check and the attestation's expiry (FR-158, REG-009). */
  chainNow: () => Promise<Date>;
  now: () => Date;
  /** §4's read, which the reject answers with. */
  detail: (caller: Operator, submissionId: string) => Promise<object>;
};

type Services = ReviewDependencies & { repository: EvidenceRepository };

type Settled = (
  caller: Operator,
  submissionId: string,
  approve: boolean,
) => Promise<{ status: number; body: object }>;

export type ReviewDecision = { approve: boolean; note: string };

const MS_PER_SECOND = 1000;
const OPERATOR_REJECTED = 'operator_rejected';
const DECIDED_BY_APPROVAL = ['attested', 'onchain', 'failed'];

const attestationKey = (submissionId: string): string => `attestation:${submissionId}`;

/** §5 concurrency: the decision already taken, if it is this one. */
const sameDecision = (row: ReviewRow, approve: boolean): boolean =>
  approve
    ? row.reviewed_at !== null && DECIDED_BY_APPROVAL.includes(row.status)
    : row.status === 'rejected' && row.reject_reasons.includes(OPERATOR_REJECTED);

/** Zero rows updated: another decision won, or this one was taken before. */
const settledOf =
  ({ database, repository, detail }: Services): Settled =>
  async (caller, submissionId, approve) => {
    const row = await repository.reviewRow(submissionId);

    if (row === undefined || !sameDecision(row, approve)) {
      throw new DomainError('not_in_review', { status: row?.status ?? 'unknown' });
    }

    if (!approve) {
      return { status: 200, body: { ...(await detail(caller, submissionId)), idempotent: true } };
    }

    const job = await jobByKey(database, attestationKey(submissionId));

    if (job === undefined) {
      throw new Error(`submission ${submissionId} is ${row.status} without its attestation job`);
    }

    return enqueuedResponse({ job, outcome: 'replayed' });
  };

/** Approve checks 10–13 of evidence-prechecks.md §1, for the submitter's target, in chain time. */
const approveReasons = async (
  repository: EvidenceRepository,
  row: ReviewRow,
  { chainTime, now }: { chainTime: Date; now: Date },
) => {
  const scope: Scope = {
    repository,
    wallet: row.wallet_address ?? '',
    chainTime,
    tagFor: (campaign, slotId) => repository.tagOf(campaign, slotId),
  };
  const { facts } =
    row.kind === 'PLANTED'
      ? await loadPlanting(scope, row.campaign_address, String(row.slot_id))
      : await loadTree(scope, {
          kind: row.kind as TreeKind,
          treeId: row.tree_id ?? '0',
          milestone: row.milestone,
          now,
        });

  return reasonsOf(approveChecks(facts));
};

/** §5: the frozen attester's fields, exactly as the worker's pass path fills them (ADR-001). */
const signFor = (attester: Attester, row: ReviewRow, chainTime: Date) => {
  const payload = row.payload as unknown as EvidencePayload;

  return attester.sign(
    {
      kind: row.kind,
      campaign: row.campaign_address as Address,
      slotId: BigInt(row.slot_id ?? 0),
      treeId: BigInt(row.tree_id ?? 0),
      planter: row.wallet_address as Address,
      milestone: row.milestone,
      evidenceHash: row.evidence_hash as Hex,
      geohash: geohashToBytes8(encodeGeohash(payload.lat, payload.lon, GEOHASH_PRECISION)),
      score: row.policy_score ?? 0,
    },
    Math.floor(chainTime.getTime() / MS_PER_SECOND),
  );
};

/** Re-check in chain time, sign outside the transaction, then attest and queue in one (ADR-004). */
const approveOf =
  ({ database, repository, attester, chainNow, now }: Services, settled: Settled) =>
  async (caller: Operator, row: ReviewRow, note: string) => {
    const chainTime = await chainNow();
    const reasons = await approveReasons(repository, row, { chainTime, now: now() });

    if (reasons.length > 0) {
      throw new DomainError('cannot_attest', { reasons });
    }

    const record = await signFor(attester, row, chainTime);
    const outcome = await database.transaction().execute(async (trx) => {
      const writes = evidenceRepository(trx);
      const decided = await writes.decide(row.id, {
        status: 'attested',
        attestation: JSON.stringify(record),
        attestation_nonce: record.attestation.nonce,
        review_note: note,
        reviewed_by_profile_id: caller.id,
        reviewed_at: now(),
      });

      if (decided === undefined) {
        return undefined;
      }

      if (row.challenge_id !== null) {
        await writes.fulfilChallenge(row.challenge_id, row.id);
      }

      return enqueue(trx, {
        kind: 'attestation',
        payload: {
          submissionId: row.id,
          nonce: record.attestation.nonce,
          attestation: record.attestation,
          signature: record.signature,
        },
        createdBy: row.profile_id,
        idempotencyKey: attestationKey(row.id),
      });
    });

    return outcome === undefined ? settled(caller, row.id, true) : enqueuedResponse(outcome);
  };

/** The policy's reasons, then `operator_rejected`; no job. */
const rejectOf =
  ({ repository, now, detail }: Services, settled: Settled) =>
  async (caller: Operator, row: ReviewRow, note: string) => {
    const decided = await repository.decide(row.id, {
      status: 'rejected',
      reject_reasons: [...row.reject_reasons, OPERATOR_REJECTED],
      review_note: note,
      reviewed_by_profile_id: caller.id,
      reviewed_at: now(),
    });

    return decided === undefined
      ? settled(caller, row.id, false)
      : { status: 200, body: await detail(caller, row.id) };
  };

/** docs/BE/features/evidence.md §5 (FR-156): an operator's decision on a `needs_review` submission. No override: a
 *  policy reject is never reviewable and `cannot_attest` cannot be bypassed. */
export const createReviewService = (dependencies: ReviewDependencies) => {
  const services = { ...dependencies, repository: evidenceRepository(dependencies.database) };
  const settled = settledOf(services);
  const approve = approveOf(services, settled);
  const reject = rejectOf(services, settled);

  return async (caller: Operator, submissionId: string, decision: ReviewDecision) => {
    const row = await services.repository.reviewRow(submissionId);

    if (row === undefined) {
      throw new DomainError('not_found');
    }

    if (row.status !== 'needs_review') {
      return settled(caller, submissionId, decision.approve);
    }

    return decision.approve
      ? approve(caller, row, decision.note)
      : reject(caller, row, decision.note);
  };
};
