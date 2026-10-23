import {
  base64UrlToBytes,
  canonicalize,
  computeEvidenceHash,
  utf8,
  verifyDeviceSignature,
  type EcPublicJwk,
  type EvidencePayload,
} from '../../generated/frozen/evidence.js';
import { aiOf } from '../../shared/ai-scores.js';
import type { Storage } from '../../shared/storage/storage.js';
import { toChallenge } from './audit.mapper.js';
import type { AuditRepository, BundleSubmissionRow } from './audit.repository.js';
import { progressOf } from './audit.rules.js';

// docs/BE/features/audit.md §4, FR-193–FR-196: one sampled tree as S25 shows it, every submission's checks recomputed
// on each read. A check that could not run is null, never shown as passed.

const EVIDENCE_BUCKET = 'evidence';
const KEYFRAMES_BUCKET = 'keyframes';
// ADR-020: the video and keyframe links live as long as every other link the API hands out
const LINK_MS = 900_000;

type BundleStorage = Pick<Storage, 'presignGet' | 'sha256Of'>;

type Row = BundleSubmissionRow;

/** null when the check cannot run: an input the frozen functions refuse, or storage that cannot answer. */
const attempt = async <Value>(run: () => Promise<Value> | Value): Promise<Value | null> => {
  try {
    return await run();
  } catch {
    return null;
  }
};

const signatureValid = async ({ canonical, signature, public_key_jwk: jwk }: Row) =>
  canonical === null || signature === null || jwk === null
    ? null
    : attempt(async () => verifyDeviceSignature(jwk as EcPublicJwk, utf8(canonical), signature));

const canonicalMatchesPayload = async ({ canonical, payload }: Row) =>
  canonical === null || payload === null
    ? null
    : attempt(() => canonicalize(payload as unknown as EvidencePayload) === canonical);

const evidenceHashMatches = async ({ canonical, signature, evidence_hash: hash }: Row) =>
  canonical === null || signature === null
    ? null
    : attempt(() => computeEvidenceHash(utf8(canonical), base64UrlToBytes(signature)) === hash);

/** FR-195: the device signature over `canonical`, `canonical` against the payload, the evidence hash, and the stored
 *  video's SHA-256 against the signed one. */
const verificationOf = async (storage: BundleStorage, row: Row) => {
  const path = row.video_path;
  const stored =
    path === null ? null : await attempt(async () => storage.sha256Of(EVIDENCE_BUCKET, path));

  return {
    signatureValid: await signatureValid(row),
    canonicalMatchesPayload: await canonicalMatchesPayload(row),
    evidenceHashMatches: await evidenceHashMatches(row),
    videoHashMatches: stored === null ? null : stored.sha256 === row.video_sha256,
    recomputedSha256: stored?.sha256 ?? null,
  };
};

const videoOf = async (storage: BundleStorage, row: Row, urlExpiresAt: string) =>
  row.video_path === null
    ? null
    : {
        path: row.video_path,
        sha256: row.video_sha256,
        sizeBytes: row.size_bytes,
        durationSec: row.duration_sec,
        url: await storage.presignGet(EVIDENCE_BUCKET, row.video_path),
        urlExpiresAt,
      };

const deviceOf = (row: Row) =>
  row.device_id === null
    ? null
    : {
        id: row.device_id,
        thumbprint: row.thumbprint,
        revokedAt: row.revoked_at?.toISOString() ?? null,
      };

const reviewOf = (row: Row) =>
  row.reviewed_at === null
    ? null
    : {
        note: row.review_note,
        reviewedAt: row.reviewed_at.toISOString(),
        decision: row.status === 'rejected' ? 'rejected' : 'approved',
      };

/** §4 `submissions[]`: the signed record with exact GPS (an auditor is an exact-GPS reader, NFR-006), presigned
 *  video and keyframes, the recomputed checks, the AI by known keys, the policy and the review. */
const toBundleSubmission = async (storage: BundleStorage, row: Row, now: Date) => ({
  id: row.id,
  kind: row.kind,
  milestone: row.milestone,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  video: await videoOf(storage, row, new Date(now.getTime() + LINK_MS).toISOString()),
  keyframeUrls: await Promise.all(
    row.keyframe_paths.map((keyframe) => storage.presignGet(KEYFRAMES_BUCKET, keyframe)),
  ),
  payload: row.payload,
  canonical: row.canonical,
  signature: row.signature,
  device: deviceOf(row),
  evidenceHash: row.evidence_hash,
  precheckResults: row.precheck_results ?? [],
  verification: await verificationOf(storage, row),
  ai: aiOf(row.ai_response),
  policy:
    row.policy_decision === null
      ? null
      : { decision: row.policy_decision, score: row.policy_score, reasons: row.reject_reasons },
  review: reviewOf(row),
  attestation: row.attestation,
  txHash: row.tx_hash,
});

type Loaded<Read extends keyof AuditRepository> = NonNullable<
  Awaited<ReturnType<AuditRepository[Read]>>
>;

const treeOf = (tree: Loaded<'bundleTree'>) => ({
  treeId: tree.tree_id,
  status: tree.status,
  campaign: tree.campaign_address,
  slotId: String(tree.slot_id),
  planter: tree.planter_address,
  location:
    tree.exact_lat === null || tree.exact_lon === null
      ? null
      : { lat: tree.exact_lat, lon: tree.exact_lon, precision: 'exact' },
  replantDeadline: tree.replant_deadline?.toISOString() ?? null,
});

/** §4 response: the sample card, the tree with its exact place, progress, every submission, its chain records, this
 *  session's latest challenge and any session's open one (without its session id, which may be another auditor's,
 *  FR-180). */
export const toTreeBundle = async (
  storage: BundleStorage,
  loaded: {
    session: Loaded<'session'>;
    sample: Loaded<'sampleOf'>;
    tree: Loaded<'bundleTree'>;
    submissions: Loaded<'bundleSubmissions'>;
    events: Loaded<'events'>;
    payouts: Loaded<'payouts'>;
    forfeited: number[];
    challenges: Loaded<'challenges'>;
    open: Loaded<'openChallenge'> | undefined;
  },
  now: Date,
) => {
  const { session, sample, tree, payouts, open } = loaded;
  const latest = loaded.challenges.find((challenge) => challenge.tree_id === tree.tree_id);

  return {
    sessionId: session.id,
    sessionStatus: session.status,
    sample: {
      position: sample.position,
      sampleSize: session.sample_size,
      treeId: tree.tree_id,
      finding: sample.finding,
      notes: sample.notes,
      recordedAt: sample.recorded_at?.toISOString() ?? null,
    },
    tree: treeOf(tree),
    progress: progressOf(
      payouts.map((payout) => payout.milestone),
      loaded.forfeited,
    ),
    submissions: await Promise.all(
      loaded.submissions.map((row) => toBundleSubmission(storage, row, now)),
    ),
    events: loaded.events.map((event) => ({
      kind: event.kind,
      block: event.block,
      at: event.block_time.toISOString(),
      txHash: event.tx_hash,
    })),
    payouts: payouts.map((payout) => ({
      milestone: payout.milestone,
      amount: payout.amount,
      txHash: payout.tx_hash,
    })),
    challenge: latest === undefined ? null : toChallenge(latest, now),
    openChallenge:
      open === undefined
        ? null
        : {
            code: open.code,
            issuedAt: open.created_at.toISOString(),
            expiresAt: open.expires_at.toISOString(),
          },
  };
};
