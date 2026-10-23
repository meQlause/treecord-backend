import {
  MILESTONE_DUE_UNITS,
  SERVER_VIDEO_MAX_SEC,
  SERVER_VIDEO_MIN_SEC,
} from '../../../generated/frozen/constants.js';
import { isoInstant as iso } from '../../../shared/instant.js';

// docs/BE/features/evidence-prechecks.md: pure rules, every instant and row passed in (epoch ms). This file holds the
// target stage (checks 9–15, the capture blocks of S16–S19), the link stage (4, 8, 9–13, 15) and the approve stage
// (10–13); the submit stage is in submit.rules.ts.

const MS_PER_SECOND = 1000;
// a held submission is shown by the first eight characters of its id (S21 "5c1e9a7d · needs_review")
const SHORT_ID = 8;

export type EvidenceKind = 'PLANTED' | 'ALIVE' | 'DEAD' | 'REPLANTED';

export type Reason =
  | 'device_unknown_or_revoked'
  | 'device_not_owned'
  | 'signature_invalid'
  | 'hash_mismatch'
  | 'stale_capture'
  | 'future_capture'
  | 'gps_inaccurate'
  | 'outside_region'
  | 'moved_tree'
  | 'challenge_missing'
  | 'tag_mismatch'
  | 'duplicate_video'
  | 'video_too_short'
  | 'video_too_long'
  | 'slot_not_owned'
  | 'tree_not_owned'
  | 'campaign_not_active'
  | 'wrong_tree_status'
  | 'replant_deadline_passed'
  | 'milestone_not_open'
  | 'milestone_already_done'
  | 'slot_already_planted'
  | 'already_reported'
  | 'tag_missing';

export type CheckId =
  | 'device'
  | 'signature'
  | 'video_hash'
  | 'capture_time'
  | 'gps_accuracy'
  | 'location'
  | 'unique_video'
  | 'duration'
  | 'ownership'
  | 'campaign_status'
  | 'tree_status'
  | 'milestone_window'
  | 'target_free'
  | 'challenge'
  | 'tag';

export type CheckRow = {
  check: CheckId;
  ok: boolean | null;
  value: string;
  limit: string;
  reason: Reason | null;
};

/** The live submission holding a target (FR-138). */
type Held = { id: string; status: string; milestone: number };

export type TargetFacts = {
  kind: EvidenceKind;
  callerWallet: string;
  /** PLANTED: the slot; others: the tree. */
  target: { label: string; planterAddress: string | null };
  campaignStatus: string;
  tree: {
    status: string;
    replantDeadline: number | null;
    plantedAt: number;
    pausedSeconds: string;
    unitSeconds: string;
  } | null;
  /** ALIVE: the milestone asked for. */
  milestone: number | null;
  /** The latest block's time (REG-009); never the server clock. */
  chainTime: number;
  held: Held | null;
  /** ALIVE: a payout for the milestone is mirrored; PLANTED: the slot has a tree. */
  mirrored: boolean;
  openChallengeCode: string | null;
  issuedTag: string | null;
};

/** FR-137, `Campaign._window`: opens at planting + paused time + the milestone's due month in units, closes one unit
 *  later; both ends count. */
export const milestoneWindow = (
  plantedAt: number,
  pausedSeconds: string,
  unitSeconds: string,
  dueMonth: number,
): { opensAt: number; closesAt: number } => {
  const unit = Number(unitSeconds) * MS_PER_SECOND;
  const opensAt = plantedAt + Number(pausedSeconds) * MS_PER_SECOND + dueMonth * unit;

  return { opensAt, closesAt: opensAt + unit };
};

/** FR-082, FR-103: the lowest milestone with neither a payout nor a forfeit; null once all six are settled. */
export const currentMilestone = (settled: {
  paid: number[];
  forfeited: number[];
}): number | null => {
  const unsettled = MILESTONE_DUE_UNITS.findIndex(
    (_month, milestone) =>
      !settled.paid.includes(milestone) && !settled.forfeited.includes(milestone),
  );

  return unsettled === -1 ? null : unsettled;
};

export type Judged = { value: string; limit: string; reason: Reason };

export const row = (
  check: CheckId,
  passed: boolean,
  { value, limit, reason }: Judged,
): CheckRow => ({
  check,
  ok: passed,
  value,
  limit,
  reason: passed ? null : reason,
});

const ownership = ({ kind, callerWallet, target }: TargetFacts): CheckRow =>
  row('ownership', target.planterAddress === callerWallet, {
    value: target.label,
    limit: 'held by this account',
    reason: kind === 'PLANTED' ? 'slot_not_owned' : 'tree_not_owned',
  });

const campaignStatus = ({ campaignStatus: status }: TargetFacts): CheckRow =>
  row('campaign_status', status === 'active', {
    value: status,
    limit: 'Active campaign',
    reason: 'campaign_not_active',
  });

/** REPLANTED: the tree is Dead and chain time has not passed its replant deadline. */
const replantable = (status: string, deadline: number | null, chainTime: number): CheckRow => {
  const value = status;
  const limit = `Dead, replant by ${deadline === null ? 'no deadline' : iso(deadline)}`;

  return status === 'dead'
    ? row('tree_status', deadline !== null && chainTime <= deadline, {
        value,
        limit,
        reason: 'replant_deadline_passed',
      })
    : row('tree_status', false, { value, limit, reason: 'wrong_tree_status' });
};

const treeStatus = ({ kind, tree, chainTime }: TargetFacts): CheckRow => {
  const status = tree?.status ?? 'unknown';

  return kind === 'REPLANTED'
    ? replantable(status, tree?.replantDeadline ?? null, chainTime)
    : row('tree_status', status === 'alive', {
        value: status,
        limit: 'Alive',
        reason: 'wrong_tree_status',
      });
};

const window = ({ tree, milestone, chainTime }: TargetFacts): CheckRow => {
  const dueMonth = milestone === null ? undefined : MILESTONE_DUE_UNITS[milestone];

  if (tree === null || dueMonth === undefined) {
    return row('milestone_window', false, {
      value: 'closed',
      limit: 'no window',
      reason: 'milestone_not_open',
    });
  }

  const { opensAt, closesAt } = milestoneWindow(
    tree.plantedAt,
    tree.pausedSeconds,
    tree.unitSeconds,
    dueMonth,
  );
  const open = opensAt <= chainTime && chainTime <= closesAt;

  return row('milestone_window', open, {
    value: open ? 'open' : 'closed',
    limit: `${iso(opensAt)} – ${iso(closesAt)}`,
    reason: 'milestone_not_open',
  });
};

const FREE_REASON: Record<EvidenceKind, Reason> = {
  PLANTED: 'slot_already_planted',
  ALIVE: 'milestone_already_done',
  DEAD: 'already_reported',
  REPLANTED: 'already_reported',
};

const takenBy = ({ kind, held, mirrored }: TargetFacts): string | null => {
  if (held !== null) {
    return `${held.id.slice(0, SHORT_ID)} · ${held.status}`;
  }

  if (mirrored) {
    return kind === 'PLANTED' ? 'planted' : 'paid';
  }

  return null;
};

const targetFree = (facts: TargetFacts): CheckRow => {
  const taken = takenBy(facts);

  return row('target_free', taken === null, {
    value: taken ?? 'free',
    limit: 'no live submission',
    reason: FREE_REASON[facts.kind],
  });
};

/** FR-139: at the target a challenge only shows its code; it never blocks (FR-093, FR-141). */
const challenge = ({ openChallengeCode: code }: TargetFacts): CheckRow => ({
  check: 'challenge',
  ok: true,
  value: code ?? 'none open',
  limit: code === null ? 'no open challenge' : `carries ${code}`,
  reason: null,
});

const tag = ({ issuedTag }: TargetFacts): CheckRow =>
  row('tag', issuedTag !== null, {
    value: issuedTag ?? 'none',
    limit: issuedTag === null ? 'a tag issued to the target' : `issued tag ${issuedTag}`,
    reason: 'tag_missing',
  });

/** §1 "Target": the checks a kind uses, in FR-130 order; a row a kind does not use is omitted. */
export const targetChecks = (facts: TargetFacts): CheckRow[] => {
  const planting = facts.kind === 'PLANTED';

  return [
    ownership(facts),
    ...(planting ? [campaignStatus(facts)] : [treeStatus(facts)]),
    ...(facts.kind === 'ALIVE' ? [window(facts)] : []),
    targetFree(facts),
    ...(planting ? [] : [challenge(facts)]),
    tag(facts),
  ];
};

/** §1 "Approve" (FR-156): the target is still open in chain time. `target_free` reads the mirror only, since the
 *  submission under review is itself the target's live holder. */
export const approveChecks = (facts: TargetFacts): CheckRow[] => {
  const planting = facts.kind === 'PLANTED';

  return [
    planting ? campaignStatus(facts) : treeStatus(facts),
    ...(facts.kind === 'ALIVE' ? [window(facts)] : []),
    targetFree({ ...facts, held: null }),
  ];
};

/** Another submission already holding the announced video hash (FR-132). */
type HashHolder = { profileId: string; status: string; sameTarget: boolean };

export type LinkFacts = TargetFacts & {
  callerProfileId: string;
  durationSec: number | null;
  existingByHash: HashHolder | null;
};

/** §2 check 4 at the link: the hash is unused, except by the caller's own queued row for this target (the retry). */
const uniqueVideo = ({ existingByHash, callerProfileId }: LinkFacts): CheckRow => {
  const retry =
    existingByHash !== null &&
    existingByHash.profileId === callerProfileId &&
    existingByHash.status === 'queued' &&
    existingByHash.sameTarget;

  return row('unique_video', existingByHash === null || retry, {
    value: existingByHash === null ? 'first use' : `held by a ${existingByHash.status} submission`,
    limit: 'unused by any earlier submission',
    reason: 'duplicate_video',
  });
};

/** §2 check 8: 4–12 s, both edges pass; an unknown duration is not checked (FR-136 "when given"). */
export const duration = ({ durationSec }: { durationSec: number | null }): CheckRow => {
  const limit = `${SERVER_VIDEO_MIN_SEC}–${SERVER_VIDEO_MAX_SEC} s`;

  if (durationSec === null) {
    return { check: 'duration', ok: null, value: 'unknown', limit, reason: null };
  }

  return row(
    'duration',
    durationSec >= SERVER_VIDEO_MIN_SEC && durationSec <= SERVER_VIDEO_MAX_SEC,
    {
      value: `${durationSec.toFixed(1)} s`,
      limit,
      reason: durationSec < SERVER_VIDEO_MIN_SEC ? 'video_too_short' : 'video_too_long',
    },
  );
};

/** §1 "Link": the upload link's checks in FR-130 order; the challenge never blocks here (FR-141). */
export const linkChecks = (facts: LinkFacts): CheckRow[] =>
  [uniqueVideo(facts), duration(facts), ...targetChecks(facts)].filter(
    (checked) => checked.check !== 'challenge',
  );

/** error-handling §4.2: every failing row's reason, in FR-130 order. */
export const reasonsOf = (rows: CheckRow[]): Reason[] =>
  rows.flatMap((checked) =>
    checked.ok === false && checked.reason !== null ? [checked.reason] : [],
  );
