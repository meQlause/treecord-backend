import { CHECK_IN_RADIUS_M, MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';
import type { DetailRow, HeldRow, SlotTarget, TreeTarget } from './evidence.repository.js';
import { reasonsOf, targetChecks, type TargetFacts } from './prechecks/prechecks.rules.js';

const monthOf = (milestone: number): number => MILESTONE_DUE_UNITS[milestone] ?? 0;

/** planter.md capture block: the target prechecks, and the live submission holding the target. */
const captureOf = (facts: TargetFacts, held: HeldRow | undefined) => {
  const reasons = reasonsOf(targetChecks(facts));

  return {
    allowed: reasons.length === 0,
    reasons,
    held:
      held === undefined
        ? null
        : {
            id: held.id,
            status: held.status,
            milestone: held.milestone,
            month: monthOf(held.milestone),
            deviceId: held.device_id,
          },
  };
};

const campaignOf = (target: SlotTarget | TreeTarget) => ({
  address: target.address,
  title: target.title,
  regionName: target.region_name,
  regionRadiusM: target.region_radius_m,
});

const regionReference = (target: SlotTarget) =>
  target.region_center_lat === null || target.region_center_lon === null
    ? null
    : {
        kind: 'region',
        lat: target.region_center_lat,
        lon: target.region_center_lon,
        radiusM: target.region_radius_m,
      };

const treeReference = (location: { lat: number | null; lon: number | null } | null) =>
  location === null || location.lat === null || location.lon === null
    ? null
    : { kind: 'tree', lat: location.lat, lon: location.lon, radiusM: CHECK_IN_RADIUS_M };

const challengeOf = (challenge: { code: string; expires_at: Date } | undefined) =>
  challenge === undefined
    ? null
    : {
        code: challenge.code,
        qr: `TCH-${challenge.code}`,
        expiresAt: challenge.expires_at.toISOString(),
      };

export type PlantingTarget = {
  facts: TargetFacts;
  held: HeldRow | undefined;
  slot: SlotTarget;
  slotId: string;
};

export type TreeTargetFacts = {
  facts: TargetFacts;
  held: HeldRow | undefined;
  tree: TreeTarget;
  challenge: { id: string; code: string; expires_at: Date } | undefined;
  location: { lat: number | null; lon: number | null } | null;
};

/** §1 for PLANTED: the slot, its region as the reference. */
export const toPlantingTarget = (
  { facts, held, slot, slotId }: PlantingTarget,
  chainTime: Date,
) => ({
  kind: 'PLANTED',
  slotId,
  treeId: slot.planted_tree,
  milestone: 0,
  month: 0,
  campaign: campaignOf(slot),
  tag: facts.issuedTag,
  challenge: null,
  reference: regionReference(slot),
  ...captureOf(facts, held),
  chainTime: chainTime.toISOString(),
});

/** §1 for a tree; `milestone` is the index the payload must sign (FR-103). */
export const toTreeTarget = (target: TreeTargetFacts, chainTime: Date) => {
  const milestone = target.facts.milestone ?? 0;

  return {
    kind: target.facts.kind,
    slotId: null,
    treeId: target.tree.tree_id,
    milestone,
    month: monthOf(milestone),
    campaign: campaignOf(target.tree),
    tag: target.facts.issuedTag,
    challenge: challengeOf(target.challenge),
    reference: treeReference(target.location),
    ...captureOf(target.facts, target.held),
    chainTime: chainTime.toISOString(),
  };
};

type PrecheckRow = { ok: boolean | null };

const STEP_OF: Readonly<Record<string, number>> = {
  queued: 1,
  uploaded: 1,
  checking: 2,
  scored: 3,
  passed: 3,
  needs_review: 3,
  attested: 4,
  onchain: 5,
};

/** FR-117: the step reached, and for a rejected or failed submission where it stopped. */
export const pipelineOf = ({
  status,
  precheck_results: results,
  attestation,
}: {
  status: string;
  precheck_results: unknown;
  attestation: unknown;
}): { step: number; failedAt: string | null } => {
  if (status !== 'rejected' && status !== 'failed') {
    return { step: STEP_OF[status] ?? 1, failedAt: null };
  }

  if (((results ?? []) as PrecheckRow[]).some((checked) => checked.ok === false)) {
    return { step: 2, failedAt: 'prechecks' };
  }

  return status === 'failed' && attestation !== null
    ? { step: 4, failedAt: 'attested' }
    : { step: 3, failedAt: 'scored' };
};

type Raw = Record<string, unknown> | null | undefined;

/** The named keys of an object, each null when absent: nothing else passes through. */
const pick = (raw: Raw, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, raw?.[key] ?? null]));

/** FR-116, FR-155: the AI's scores by known keys only; the raw response (its keyframe URLs, notes) never leaves. */
const aiOf = (response: unknown) => {
  if (response === null || response === undefined) {
    return null;
  }

  const { modelVersion, scores } = response as {
    modelVersion?: string;
    scores?: Record<string, Raw>;
  };
  const raw: Record<string, Raw> = scores ?? {};

  return {
    modelVersion: modelVersion ?? null,
    scores: {
      ...pick(raw as Raw, [
        'liveness',
        'recapture',
        'treePresence',
        'speciesMatch',
        'growthConsistency',
      ]),
      duplicate: pick(raw['duplicate'], ['maxSimilarity', 'matchedSubmissionId']),
      ...pick(raw as Raw, ['challengeVisible']),
      ndvi: raw['ndvi'] ? pick(raw['ndvi'], ['value', 'source']) : null,
      ...pick(raw as Raw, ['tagDecoded']),
    },
  };
};

/** FR-116, FR-156: the reviewer's decision once one exists. */
const reviewOf = (row: DetailRow) =>
  row.reviewed_at === null
    ? null
    : {
        note: row.review_note,
        reviewedAt: row.reviewed_at.toISOString(),
        decision: row.status === 'rejected' ? 'rejected' : 'approved',
      };

/** §4: one submission for S21 and S28. `withError` for operators only (NFR-055). */
export const toDetail = (
  row: DetailRow,
  {
    keyframes,
    withError,
  }: { keyframes: { urls: string[]; expiresAt: string | null }; withError: boolean },
) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  campaign: {
    address: row.address,
    title: row.title,
    regionName: row.region_name,
    regionRadiusM: row.region_radius_m,
  },
  slotId: row.slot_id === null ? null : String(row.slot_id),
  treeId: row.tree_id,
  milestone: row.milestone,
  month: monthOf(row.milestone),
  capturedAt: row.captured_at?.toISOString() ?? null,
  receivedAt: row.received_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  durationSec: row.duration_sec,
  sizeBytes: row.size_bytes,
  deviceId: row.device_id,
  videoSha256: row.video_sha256,
  payload: row.payload,
  canonical: row.canonical,
  signature: row.signature,
  evidenceHash: row.evidence_hash,
  precheckResults: row.precheck_results ?? [],
  rejectReasons: row.reject_reasons,
  policyDecision: row.policy_decision,
  policyScore: row.policy_score,
  ai: aiOf(row.ai_response),
  keyframes,
  challenge: row.challenge_id === null ? null : { id: row.challenge_id, code: row.challenge_code },
  review: reviewOf(row),
  pipeline: pipelineOf(row),
  jobId: row.job_id,
  txHash: row.tx_hash,
  ...(withError && row.status === 'failed' ? { error: row.error } : {}),
});
