// FR-116, FR-155, FR-195: the AI's scores as the evidence detail (S21, S28) and the audit bundle (S25) show them.

type Raw = Record<string, unknown> | null | undefined;

/** The named keys of an object, each null when absent: nothing else passes through. */
const pick = (raw: Raw, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, raw?.[key] ?? null]));

/** FR-116, FR-155: the AI's scores by known keys only; the raw response (its keyframe URLs, notes) never leaves. */
export const aiOf = (response: unknown) => {
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
