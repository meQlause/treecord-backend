import type { AiScoreRequest, AiScoreResponse, AiScores } from '../../generated/frozen/ai.js';
import type { AiScoreContext } from './ai-client.js';
import { AiServiceError } from './ai-service-error.js';

const MOCK_MODEL_VERSION = 'treecord-ai-mock-0.1.0';

/** A 1x1 grey JPEG, returned as the mock keyframe so keyframe storage is exercised end to end. */
const MOCK_KEYFRAME_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

type ScoreOverride = Partial<Omit<AiScores, 'duplicate'>> & { duplicateSimilarity?: number };

type Hook = ScoreOverride | 'unreadable' | 'busy' | 'bad_input';

/**
 * Deterministic failures for tests and demos, selected by the challenge field of the signed payload. Anything else
 * gets passing scores.
 */
const MOCK_AI_HOOKS: Record<string, Hook> = {
  'FAIL-LIVENESS': { liveness: 0.4 },
  'REVIEW-LIVENESS': { liveness: 0.75 },
  'FAIL-RECAPTURE': { recapture: 0.6 },
  'FAIL-PRESENCE': { treePresence: 0.3 },
  'FAIL-DUPLICATE': { duplicateSimilarity: 0.95 },
  'FAIL-GROWTH': { growthConsistency: 0.2 },
  'MISSING-GROWTH': { growthConsistency: null },
  'FAIL-TAG': { tagDecoded: null },
  UNREADABLE: 'unreadable',
  BUSY: 'busy',
  'BAD-INPUT': 'bad_input',
};

const FAILURES = {
  unreadable: { status: 422, message: 'Mock: video unreadable', retryable: false },
  busy: { status: 503, message: 'Mock: service busy', retryable: true },
  bad_input: { status: 400, message: 'Mock: bad input', retryable: false },
};

const PASSING = {
  liveness: 0.93,
  recapture: 0.04,
  treePresence: 0.95,
  speciesMatch: 0.8,
  growthConsistency: 0.86,
  challengeVisible: 0.95,
  ndvi: 0.42,
  duplicateSimilarity: 0.1,
};
const DATE_CHARS = 10;

/** Passing scores, with a hook's overrides on top. */
const mockScores = (
  request: AiScoreRequest,
  context: AiScoreContext,
  hook: ScoreOverride | undefined,
): AiScores => {
  const { duplicateSimilarity, ...scoreOverride } = hook ?? {};
  const isRealChallenge = request.challengeCode !== null && hook === undefined;

  return {
    liveness: PASSING.liveness,
    recapture: PASSING.recapture,
    treePresence: PASSING.treePresence,
    speciesMatch: PASSING.speciesMatch,
    growthConsistency: request.kind === 'PLANTED' ? null : PASSING.growthConsistency,
    challengeVisible: isRealChallenge ? PASSING.challengeVisible : null,
    tagDecoded: context.tag ?? null,
    ndvi: { value: PASSING.ndvi, source: 'mock', date: request.capturedAt.slice(0, DATE_CHARS) },
    ...scoreOverride,
    duplicate: {
      maxSimilarity: duplicateSimilarity ?? PASSING.duplicateSimilarity,
      matchedSubmissionId: null,
    },
  };
};

/** Returns passing scores unless the challenge code names a hook in MOCK_AI_HOOKS. */
export class MockAiClient {
  readonly requests: AiScoreRequest[] = [];

  score(request: AiScoreRequest, context: AiScoreContext = {}): Promise<AiScoreResponse> {
    this.requests.push(request);
    const hook = request.challengeCode ? MOCK_AI_HOOKS[request.challengeCode] : undefined;

    if (typeof hook === 'string') {
      const failure = FAILURES[hook];

      return Promise.reject(new AiServiceError(failure.status, failure.message, failure.retryable));
    }

    return Promise.resolve({
      submissionId: request.submissionId,
      modelVersion: MOCK_MODEL_VERSION,
      scores: mockScores(request, context, hook),
      keyframes: [MOCK_KEYFRAME_DATA_URL],
      notes: ['Mock scores. Set MOCK_AI=false to call the real service.'],
    });
  }
}
