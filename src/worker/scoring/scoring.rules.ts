// The scorer's pure decisions: the tag a device signed, the outcome a job reports, and keyframe decoding limits.
import type { EvidencePayload } from '../../generated/frozen/evidence.js';
import { base64UrlToBytes } from '../../generated/frozen/evidence.js';

type SubmissionLike = {
  payload: unknown;
  status: ScoreOutcome['status'];
  reject_reasons: string[];
  policy_score: number | null;
};

export type ScoreOutcome = {
  status:
    | 'uploaded'
    | 'checking'
    | 'scored'
    | 'passed'
    | 'needs_review'
    | 'rejected'
    | 'attested'
    | 'onchain'
    | 'failed'
    | 'queued';
  reasons: string[];
  policyScore: number | null;
  /** The attestation job, when the submission was attested. */
  jobId: string | null;
  /** True when the submission was not in a scorable state, so nothing was done. */
  skipped: boolean;
};

/** The tree tag the device signed (FR-089), or null for a payload signed before tags existed. */
export const signedTag = (submission: { payload: unknown }): string | null =>
  (submission.payload as EvidencePayload | null)?.tag ?? null;

export const outcome = (
  submission: SubmissionLike,
  jobId: string | null,
  skipped: boolean,
): ScoreOutcome => ({
  status: submission.status,
  reasons: submission.reject_reasons,
  policyScore: submission.policy_score,
  jobId,
  skipped,
});

/** Previous keyframes sent to the AI for growth consistency. */
export const MAX_PREVIOUS_KEYFRAMES = 6;

/** Bucket limit from the storage migration. */
const MAX_KEYFRAME_BYTES = 2_097_152;

/** Keyframes kept per submission. */
export const MAX_KEYFRAMES = 8;

/** The error text stored on a failed submission is cut at this many characters. */
export const MAX_ERROR_CHARS = 1000;

export const KEYFRAME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type KeyframeImage = { bytes: Uint8Array; contentType: string };

export const checkKeyframeSize = (image: KeyframeImage): KeyframeImage => {
  if (image.bytes.length === 0 || image.bytes.length > MAX_KEYFRAME_BYTES) {
    throw new Error(
      `keyframe size ${image.bytes.length} is outside 1 to ${MAX_KEYFRAME_BYTES} bytes`,
    );
  }

  return image;
};

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

/** A base64 data URL as image bytes, or an error for anything else. */
export const decodeDataUrl = (source: string): KeyframeImage => {
  const match = DATA_URL.exec(source);

  if (!match?.[1] || !match[2]) {
    throw new Error('unsupported data URL');
  }

  let end = match[2].length;

  // base64 padding: at most two trailing '='
  while (end > 0 && match[2][end - 1] === '=') {
    end -= 1;
  }

  const base64Url = match[2].slice(0, end).replace(/\+/g, '-').replace(/\//g, '_');

  return checkKeyframeSize({ bytes: base64UrlToBytes(base64Url), contentType: match[1] });
};

/** keyframes/{submissionId}/{index}.{ext} */
export const keyframePath = (submissionId: string, index: number, contentType: string): string =>
  `${submissionId}/${index}.${KEYFRAME_EXTENSIONS[contentType] ?? 'jpg'}`;
