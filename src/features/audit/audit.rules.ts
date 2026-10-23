import { AUDIT_SAMPLE_ALGORITHM, reportHash } from '../../generated/frozen/audit.js';
import { MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';

// docs/BE/features/audit.md §7, §10, FR-190–FR-192: the closed report, built from what the session froze. Pure: every
// instant arrives as an ISO string, the salt as hex.

export type Finding = 'ok' | 'issue' | 'needs_followup';

export type SampleFacts = {
  position: number;
  treeId: string;
  finding: Finding | null;
  notes: string | null;
  recordedAt: string | null;
};

export type ChallengeFacts = {
  treeId: string;
  code: string;
  issuedAt: string;
  expiresAt: string;
  fulfilledSubmissionId: string | null;
};

type SessionFacts = {
  id: string;
  campaign: string;
  blockNumber: string;
  blockHash: string;
  seed: string;
  population: string[];
  sampleSize: number;
};

/** §7 step 2 (FR-190): the sampled trees still without a finding, in position order. */
export const missingFindings = (samples: SampleFacts[]): string[] =>
  samples.filter((sample) => sample.finding === null).map((sample) => sample.treeId);

const count = (samples: SampleFacts[], finding: Finding): number =>
  samples.filter((sample) => sample.finding === finding).length;

/** §10 totals. */
export const totalsOf = (samples: SampleFacts[]) => ({
  ok: count(samples, 'ok'),
  issue: count(samples, 'issue'),
  needsFollowup: count(samples, 'needs_followup'),
});

/** §7 step 4, FR-191: the public report and the private notes it seals by `notesHash`, both hashed over canonical
 *  JSON (FR-192). Every key present; absent values null, never omitted. */
export const buildReport = ({
  session,
  auditor,
  samples,
  challenges,
  closedAt,
  salt,
  summary,
}: {
  session: SessionFacts;
  auditor: { profileId: string; wallet: string | null };
  samples: SampleFacts[];
  challenges: ChallengeFacts[];
  closedAt: string;
  salt: string;
  summary: string;
}) => {
  const notes = {
    salt,
    findings: samples.map(({ position, notes: text }) => ({ position, notes: text })),
    summary,
  };
  const report = {
    version: 1,
    sessionId: session.id,
    campaign: session.campaign,
    auditor,
    seed: {
      blockNumber: session.blockNumber,
      blockHash: session.blockHash,
      seed: session.seed,
      algorithm: AUDIT_SAMPLE_ALGORITHM,
    },
    population: session.population,
    sampleSize: session.sampleSize,
    findings: samples.map(({ position, treeId, finding, recordedAt }) => ({
      position,
      treeId,
      finding,
      recordedAt,
    })),
    totals: totalsOf(samples),
    challenges,
    notesHash: reportHash(notes),
    closedAt,
  };

  return { report, notes, reportHash: reportHash(report) };
};

export type ChallengeRefusal =
  | { code: 'session_closed' }
  | { code: 'not_found' }
  | { code: 'challenge_active'; details: { challengeId: string; expiresAt: string } }
  | { code: 'tree_not_alive'; details: { status: string } };

/** §6, FR-198, REG-007: the first refusal that applies, in the backend order: a closed session, a tree outside the
 *  sample, an open challenge on the tree from any session, a tree that is not Alive; null when it may be issued. */
export const challengeRefusal = ({
  sessionStatus,
  sampled,
  openChallenge,
  treeStatus,
}: {
  sessionStatus: string;
  sampled: boolean;
  openChallenge: { id: string; expiresAt: string } | null;
  treeStatus: string;
}): ChallengeRefusal | null => {
  if (sessionStatus === 'closed') {
    return { code: 'session_closed' };
  }

  if (!sampled) {
    return { code: 'not_found' };
  }

  if (openChallenge !== null) {
    return {
      code: 'challenge_active',
      details: { challengeId: openChallenge.id, expiresAt: openChallenge.expiresAt },
    };
  }

  return treeStatus === 'alive'
    ? null
    : { code: 'tree_not_alive', details: { status: treeStatus } };
};

const LAST_MONTH = Math.max(...MILESTONE_DUE_UNITS);

/** §4, FR-196: "Milestones paid 2/6" and the month of the lowest milestone neither paid nor forfeited; the last month
 *  once all six are settled. */
export const progressOf = (paid: number[], forfeited: number[]) => {
  const open = MILESTONE_DUE_UNITS.map((month, milestone) => ({ month, milestone })).find(
    ({ milestone }) => !paid.includes(milestone) && !forfeited.includes(milestone),
  );

  return { milestonesPaid: paid.length, month: open === undefined ? LAST_MONTH : open.month };
};
