import { MILESTONE_DUE_UNITS } from '../../../generated/frozen/constants.js';
import { isoInstant as iso } from '../../../shared/instant.js';

// docs/BE/features/evidence-prechecks.md: pure rules, every instant and row passed in (epoch ms). This file holds the
// target stage (checks 9–15, the capture blocks of S16–S19); B5b adds the link, submit and approve stages.

const MS_PER_SECOND = 1000;
// a held submission is shown by the first eight characters of its id (S21 "5c1e9a7d · needs_review")
const SHORT_ID = 8;

export type EvidenceKind = 'PLANTED' | 'ALIVE' | 'DEAD' | 'REPLANTED';

export type Reason =
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

type CheckId =
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

/** FR-137, `Campaign._window`: opens at planting + paused time + due units, closes one unit later; both ends count. */
export const milestoneWindow = (
  plantedAt: number,
  pausedSeconds: string,
  unitSeconds: string,
  milestone: number,
): { opensAt: number; closesAt: number } => {
  const unit = Number(unitSeconds) * MS_PER_SECOND;
  const opensAt =
    plantedAt +
    Number(pausedSeconds) * MS_PER_SECOND +
    (MILESTONE_DUE_UNITS[milestone] ?? 0) * unit;

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

type Judged = { value: string; limit: string; reason: Reason };

const row = (check: CheckId, passed: boolean, { value, limit, reason }: Judged): CheckRow => ({
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
  if (tree === null || milestone === null) {
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
    milestone,
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

/** error-handling §4.2: every failing row's reason, in FR-130 order. */
export const reasonsOf = (rows: CheckRow[]): Reason[] =>
  rows.flatMap((checked) =>
    checked.ok === false && checked.reason !== null ? [checked.reason] : [],
  );
