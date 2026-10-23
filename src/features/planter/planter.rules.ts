import {
  BPS,
  MILESTONE_DUE_UNITS,
  MILESTONE_SHARES_BPS,
} from '../../generated/frozen/constants.js';
import { milestoneWindow } from '../evidence/index.js';

// docs/BE/features/planter.md: the workspace maths and the tag code, pure; instants are epoch ms.

const BPS_BIG = BigInt(BPS);
const LAST_MILESTONE = MILESTONE_DUE_UNITS.length - 1;

// §5: 31 characters without look-alikes (no I, L, O, 0, 1); the column's CHECK is the same set
const TAG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// the largest multiple of 31 below 256: a byte at or above it would favour the first characters
const UNBIASED_BELOW = 248;
const TAG_GROUP = 4;

/** §5: TC-XXXX-XXXX from CSPRNG bytes, each character equally likely; null when too few bytes were usable. */
export const tagCode = (bytes: Uint8Array): string | null => {
  const chars = [...bytes]
    .filter((byte) => byte < UNBIASED_BELOW)
    .slice(0, TAG_GROUP * 2)
    .map((byte) => TAG_ALPHABET[byte % TAG_ALPHABET.length]);

  return chars.length < TAG_GROUP * 2
    ? null
    : `TC-${chars.slice(0, TAG_GROUP).join('')}-${chars.slice(TAG_GROUP).join('')}`;
};

/** §1: per milestone; before activation the per-tree share is derived from the target and split. */
export const milestoneAmounts = (campaign: {
  perTreeIncentive: string | null;
  fundingTarget: string;
  incentivesBps: number;
  treeTarget: number;
}): string[] => {
  const perTree =
    campaign.perTreeIncentive === null
      ? (BigInt(campaign.fundingTarget) * BigInt(campaign.incentivesBps)) /
        BPS_BIG /
        BigInt(campaign.treeTarget)
      : BigInt(campaign.perTreeIncentive);
  const shares = MILESTONE_SHARES_BPS.slice(0, LAST_MILESTONE).map(
    (bps) => (perTree * BigInt(bps)) / BPS_BIG,
  );

  return [...shares, shares.reduce((left, share) => left - share, perTree)].map(String);
};

export type MilestoneState = 'paid' | 'forfeited' | 'paused' | 'open' | 'upcoming' | 'missed';

export type TreeTiming = {
  status: string;
  plantedAt: number;
  pausedSeconds: string;
  unitSeconds: string;
};

export type Settled = { paid: number[]; forfeited: number[] };

const stateOf = (
  tree: TreeTiming,
  settled: Settled,
  {
    milestone,
    opensAt,
    closesAt,
    chainTime,
  }: { milestone: number; opensAt: number; closesAt: number; chainTime: number },
): MilestoneState => {
  if (settled.paid.includes(milestone)) {
    return 'paid';
  }

  if (settled.forfeited.includes(milestone) || tree.status === 'removed') {
    return 'forfeited';
  }

  if (tree.status === 'flagged') {
    return 'paused';
  }

  if (chainTime < opensAt) {
    return 'upcoming';
  }

  return chainTime <= closesAt ? 'open' : 'missed';
};

/** §1 FR-082: settled rows first, then a flagged tree pauses, then chain time against the inclusive window. */
export const milestoneStates = (tree: TreeTiming, settled: Settled, chainTime: number) =>
  MILESTONE_DUE_UNITS.map((month, milestone) => {
    const { opensAt, closesAt } = milestoneWindow(
      tree.plantedAt,
      tree.pausedSeconds,
      tree.unitSeconds,
      milestone,
    );

    return {
      milestone,
      month,
      state: stateOf(tree, settled, { milestone, opensAt, closesAt, chainTime }),
      opensAt,
      closesAt,
    };
  });

/** §1: the lowest milestone with neither a payout nor a forfeit; null once all six are settled. */
export const currentMilestone = (settled: Settled): number | null => {
  const unsettled = MILESTONE_DUE_UNITS.findIndex(
    (_month, milestone) =>
      !settled.paid.includes(milestone) && !settled.forfeited.includes(milestone),
  );

  return unsettled === -1 ? null : unsettled;
};

const PERCENT = 100;
const ONE_DECIMAL = 10;

/** §1 summary: trees still standing over all my trees, as a percent with one decimal; null without trees. */
export const survivalPct = (standing: number, all: number): number | null =>
  all === 0 ? null : Math.round((standing * PERCENT * ONE_DECIMAL) / all) / ONE_DECIMAL;
