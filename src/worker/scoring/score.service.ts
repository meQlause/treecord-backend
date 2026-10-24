// The `score` relayer job (PRODUCT_KNOWLEDGE.md section 15, rule 5): call the AI service, store its answer and
// keyframes, apply the policy, and attest passing submissions. Runs in the worker, never in a user request.
import {
  aiScoreResponseSchema,
  type AiScoreRequest,
  type AiScoreResponse,
} from '../../generated/frozen/ai.js';
import type { EvidencePayload } from '../../generated/frozen/evidence.js';
import { applyPolicy } from '../../generated/frozen/policy.js';
import type { WorkerStorage } from '../../shared/storage/storage.js';
import {
  EVIDENCE_BUCKET,
  KEYFRAMES_BUCKET,
  type Json,
  type Logger,
} from '../worker-db.repository.js';
import type { AiClient } from './ai-client.js';
import { AiServiceError } from './ai-service-error.js';
import { attestSubmission, ensureAttestationJob, type AttestDeps } from './attest.service.js';
import { storeKeyframes } from './keyframes.service.js';
import {
  MAX_ERROR_CHARS,
  MAX_PREVIOUS_KEYFRAMES,
  outcome,
  signedTag,
  type ScoreOutcome,
} from './scoring.rules.js';
import {
  loadCampaignSpecies,
  loadPreviousKeyframePaths,
  loadSubmission,
  loadTreeForScoring,
  transitionSubmission,
  type SubmissionChanges,
  type SubmissionRow,
  type SubmissionStatus,
} from './submissions.repository.js';

export type ScoreDeps = AttestDeps & {
  ai: AiClient;
  /** Evidence videos and keyframes. */
  storage: WorkerStorage;
  log: Logger;
  /** Used to download keyframes returned as URLs. */
  fetch?: typeof fetch;
};

export type ScoreJobOptions = {
  /** True on the job's last attempt: a retryable AI failure then fails the submission instead of throwing. */
  finalAttempt?: boolean;
};

const UNREADABLE = 422;

const mustLoad = async (deps: ScoreDeps, id: string): Promise<SubmissionRow> => {
  const row = await loadSubmission(deps.db, id);

  if (!row) {
    throw new Error(`Submission ${id} disappeared`);
  }

  return row;
};

const finish = async (
  deps: ScoreDeps,
  submission: SubmissionRow,
  from: SubmissionStatus[],
  changes: SubmissionChanges,
): Promise<ScoreOutcome> => {
  const updated = await transitionSubmission(deps.db, submission.id, from, changes);

  return outcome(updated ?? (await mustLoad(deps, submission.id)), null, updated === null);
};

/** Read links for the tree's earlier keyframes; a keyframe that no longer exists is left out. */
const previousKeyframes = async (
  deps: ScoreDeps,
  submissionId: string,
  tree: Parameters<typeof loadPreviousKeyframePaths>[2],
): Promise<string[]> => {
  const paths = await loadPreviousKeyframePaths(
    deps.db,
    submissionId,
    tree,
    MAX_PREVIOUS_KEYFRAMES,
  );
  const signed = await Promise.all(
    paths.map((path) => deps.storage.signedReadUrl(KEYFRAMES_BUCKET, path)),
  );

  return signed.filter((url): url is string => url !== null);
};

const treeOf = async (
  deps: ScoreDeps,
  submission: SubmissionRow,
): Promise<AiScoreRequest['tree']> => {
  if (submission.tree_id === null) {
    return null;
  }

  const tree = await loadTreeForScoring(deps.db, submission.tree_id);

  return {
    treeId: String(tree.tree_id),
    previousKeyframes: await previousKeyframes(deps, submission.id, tree),
    plantedAt: new Date(tree.planted_at).toISOString(),
  };
};

const buildRequest = async (
  deps: ScoreDeps,
  submission: SubmissionRow,
): Promise<AiScoreRequest> => {
  const payload = submission.payload as unknown as EvidencePayload | null;

  if (!payload || !submission.video_path) {
    throw new Error(`Submission ${submission.id} has no payload or video`);
  }

  const videoUrl = await deps.storage.signedReadUrl(EVIDENCE_BUCKET, submission.video_path);

  if (!videoUrl) {
    throw new Error(`Video ${submission.video_path} not found`);
  }

  const campaign = await loadCampaignSpecies(deps.db, submission.campaign_address);

  return {
    submissionId: submission.id,
    kind: submission.kind,
    video: {
      url: videoUrl,
      sha256: submission.video_sha256,
      durationHintSec: submission.duration_sec,
    },
    species: campaign.species_name ?? campaign.species_code ?? 'unknown',
    location: { lat: payload.lat, lon: payload.lon, acc: payload.acc },
    capturedAt: payload.capturedAt,
    challengeCode: payload.challenge,
    tree: await treeOf(deps, submission),
  };
};

/** An AI failure that is final for this attempt: unreadable rejects, the rest fail the submission. */
const settleAiFailure = (
  deps: ScoreDeps,
  submission: SubmissionRow,
  error: AiServiceError,
): Promise<ScoreOutcome> => {
  if (error.status === UNREADABLE) {
    deps.log.info(
      { submissionId: submission.id, error: error.message },
      'AI could not read the video',
    );

    return finish(deps, submission, ['checking'], {
      status: 'rejected',
      reject_reasons: ['video_unreadable'],
    });
  }

  deps.log.error({ submissionId: submission.id, error: error.message }, 'AI scoring failed');

  return finish(deps, submission, ['checking'], {
    status: 'failed',
    error: error.message.slice(0, MAX_ERROR_CHARS),
  });
};

type Scored = { scored: SubmissionRow } | { settled: ScoreOutcome };

/** `checking` → `scored`: call the AI and store its answer and keyframes. */
const callAi = async (
  deps: ScoreDeps,
  submission: SubmissionRow,
  options: ScoreJobOptions,
): Promise<Scored> => {
  let response: AiScoreResponse;

  try {
    response = await deps.ai.score(await buildRequest(deps, submission), {
      tag: signedTag(submission),
    });
  } catch (error) {
    if (!(error instanceof AiServiceError) || (error.retryable && !options.finalAttempt)) {
      throw error;
    }

    return { settled: await settleAiFailure(deps, submission, error) };
  }

  const keyframePaths = await storeKeyframes({
    storage: deps.storage,
    submissionId: submission.id,
    keyframes: response.keyframes,
    log: deps.log,
    ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
  });
  const scored = await transitionSubmission(deps.db, submission.id, ['checking'], {
    status: 'scored',
    ai_response: response as unknown as Json,
    keyframe_paths: keyframePaths,
  });

  return scored
    ? { scored }
    : { settled: outcome(await mustLoad(deps, submission.id), null, true) };
};

/** `scored`: apply the policy to the stored response, and attest a pass. */
const decide = async (deps: ScoreDeps, submission: SubmissionRow): Promise<ScoreOutcome> => {
  const response = aiScoreResponseSchema.parse(submission.ai_response);
  const policy = applyPolicy(response.scores, {
    kind: submission.kind,
    challengeIssued: submission.challenge_id !== null,
    tag: signedTag(submission),
  });
  const policyFields = {
    policy_decision: policy.decision,
    policy_score: policy.score,
    reject_reasons: policy.reasons,
  };

  if (policy.decision !== 'pass') {
    return finish(deps, submission, ['scored'], {
      ...policyFields,
      status: policy.decision === 'reject' ? 'rejected' : 'needs_review',
    });
  }

  const passed = await transitionSubmission(deps.db, submission.id, ['scored'], policyFields);

  if (!passed) {
    return outcome(await mustLoad(deps, submission.id), null, true);
  }

  const attested = await attestSubmission(deps, passed, ['scored']);

  return outcome(attested.submission, attested.jobId, false);
};

/**
 * Processes one score job. Idempotent: a submission that moved past `checking` is not scored again, and a retry
 * after a crash resumes from the stored AI response (`scored`) instead of calling the AI twice. Throws only for
 * retryable failures (AI busy or unreachable, database errors), so the job queue can retry.
 */
export const processScoreJob = async (
  deps: ScoreDeps,
  submissionId: string,
  options: ScoreJobOptions = {},
): Promise<ScoreOutcome> => {
  const submission = await loadSubmission(deps.db, submissionId);

  if (!submission) {
    throw new Error(`Submission ${submissionId} not found`);
  }

  if (submission.status === 'attested') {
    const { jobId } = await ensureAttestationJob(deps.db, submission);

    return outcome(submission, jobId, true);
  }

  if (submission.status === 'scored') {
    return decide(deps, submission);
  }

  if (submission.status !== 'checking') {
    return outcome(submission, null, true);
  }

  const result = await callAi(deps, submission, options);

  return 'scored' in result ? decide(deps, result.scored) : result.settled;
};
