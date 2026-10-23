import type { ChallengeRow, SampleRow, SessionRow } from './audit.repository.js';

/** §3, FR-199: answered once a check-in carried it on chain, else open until it expires. */
const statusOf = (row: ChallengeRow, now: Date): string => {
  if (row.fulfilled_submission_id !== null) {
    return 'answered';
  }

  return row.expires_at > now ? 'open' : 'expired';
};

export const toChallenge = (row: ChallengeRow, now: Date) => ({
  id: row.id,
  code: row.code,
  issuedAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  fulfilledSubmissionId: row.fulfilled_submission_id,
  status: statusOf(row, now),
});

/** docs/BE/features/audit.md §3: the session, its frozen inputs and every sample card in position order. */
export const toSession = (
  session: SessionRow,
  { samples, challenges, now }: { samples: SampleRow[]; challenges: ChallengeRow[]; now: Date },
) => {
  // newest first, so the first one per tree is its latest in this session
  const latest = new Map<string, ChallengeRow>();

  for (const challenge of challenges) {
    if (!latest.has(challenge.tree_id)) {
      latest.set(challenge.tree_id, challenge);
    }
  }

  return {
    id: session.id,
    status: session.status,
    campaign: {
      address: session.campaign_address,
      title: session.title,
      regionName: session.region_name,
    },
    seed: {
      blockNumber: session.seed_block_number,
      blockHash: session.seed_block_hash,
      seed: session.seed,
    },
    population: session.population,
    sampleSize: session.sample_size,
    samples: samples.map((sample) => {
      const challenge = latest.get(sample.tree_id);

      return {
        position: sample.position,
        treeId: sample.tree_id,
        treeStatus: sample.status,
        finding: sample.finding,
        notes: sample.notes,
        recordedAt: sample.recorded_at?.toISOString() ?? null,
        challenge: challenge === undefined ? null : toChallenge(challenge, now),
      };
    }),
    findingsRecorded: samples.filter((sample) => sample.finding !== null).length,
    challengesIssued: challenges.length,
    reportHash: session.report_hash,
    createdAt: session.created_at.toISOString(),
    closedAt: session.closed_at?.toISOString() ?? null,
  };
};

type PublicSession = {
  id: string;
  status: string;
  campaign_address: string;
  title: string | null;
  seed_block_number: string;
  seed_block_hash: string;
  seed: string;
  population: string[];
  sample_size: number;
  sample: string[];
  report: unknown;
  report_hash: string | null;
};

/** §9, FR-203, REG-003: an explicit allow-list, never the session row spread; no notes, summary or auditor list. */
export const toReproduction = (
  session: PublicSession,
  check: {
    seedMatches: boolean;
    recomputedSample: string[];
    sampleMatches: boolean;
    reportMatches: boolean | null;
  },
  algorithm: string,
) => ({
  sessionId: session.id,
  status: session.status,
  campaign: { address: session.campaign_address, title: session.title },
  blockNumber: session.seed_block_number,
  blockHash: session.seed_block_hash,
  seed: session.seed,
  algorithm,
  population: session.population,
  sampleSize: session.sample_size,
  sample: session.sample,
  check,
  reportHash: session.report_hash,
  report: session.report,
});
