import { MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';
import type { TreeRecords, TreeRow, ViewerRecords } from './trees.repository.js';
import {
  currentMilestone,
  milestoneAmounts,
  milestoneStatus,
  milestoneWindows,
  sumAmounts,
} from './trees.rules.js';

export type Location = {
  precision: 'exact' | 'geohash';
  lat: number;
  lon: number;
  geohash: string;
};

const monthOf = (milestone: number): number => MILESTONE_DUE_UNITS[milestone] ?? 0;

/** trees §1 `tree`. */
export const toTree = (tree: TreeRow, location: Location) => ({
  treeId: tree.tree_id,
  status: tree.status,
  campaign: {
    address: tree.campaign_address,
    title: tree.title,
    species:
      tree.species_code === null ? null : { code: tree.species_code, name: tree.species_name },
    region: { name: tree.region_name },
  },
  slotId: tree.slot_id,
  planterAddress: tree.planter_address,
  plantedAt: tree.planted_at.toISOString(),
  plantedTxHash: tree.planted_tx,
  location,
  tag: tree.tag,
  replantDeadline: tree.replant_deadline?.toISOString() ?? null,
});

/** FR-054: one entry per chain event; `thumbnails` holds each entry's presigned first keyframe, or null. */
export const toTimeline = (rows: TreeRecords['timeline'], thumbnails: (string | null)[]) =>
  rows.map((row, index) => ({
    kind: row.kind,
    at: row.block_time.toISOString(),
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    evidenceHash: row.evidence_hash,
    evidence:
      row.evidence_kind === null || row.milestone === null
        ? null
        : {
            kind: row.evidence_kind,
            milestone: row.milestone,
            month: monthOf(row.milestone),
            score: row.policy_score,
            thumbnailUrl: thumbnails[index] ?? null,
          },
  }));

/** FR-055, FR-056: the six windows, their amounts and statuses at chain time `now`. */
export const toMilestones = (tree: TreeRow, records: TreeRecords, now: Date) => {
  const paid = records.payouts.map((row) => row.milestone);
  const forfeited = records.forfeits.map((row) => row.milestone);
  const amounts = milestoneAmounts(tree.per_tree_incentive);

  return milestoneWindows(
    tree.planted_at.getTime(),
    tree.time_unit_seconds,
    tree.paused_seconds,
  ).map((window) => ({
    milestone: window.milestone,
    month: window.month,
    opensAt: new Date(window.opensAt).toISOString(),
    closesAt: new Date(window.closesAt).toISOString(),
    amount: amounts[window.milestone] ?? null,
    status: milestoneStatus({
      paid: paid.includes(window.milestone),
      forfeited: forfeited.includes(window.milestone),
      treeStatus: tree.status,
      opensAt: window.opensAt,
      closesAt: window.closesAt,
      now: now.getTime(),
    }),
  }));
};

/** FR-057, and the payouts, forfeits and flags lists. */
export const toRecords = (tree: TreeRow, records: TreeRecords) => {
  const paid = records.payouts.map((row) => row.milestone);
  const current = currentMilestone(
    paid,
    records.forfeits.map((row) => row.milestone),
  );

  return {
    payouts: records.payouts.map((row) => ({
      milestone: row.milestone,
      month: monthOf(row.milestone),
      amount: row.amount,
      planterAddress: row.planter_address,
      at: row.block_time.toISOString(),
      txHash: row.tx_hash,
    })),
    forfeits: records.forfeits.map((row) => ({
      milestone: row.milestone,
      month: monthOf(row.milestone),
      amount: row.amount,
      at: row.block_time.toISOString(),
      txHash: row.tx_hash,
    })),
    summary: {
      milestonesPaid: paid.length,
      paidAmount: sumAmounts(records.payouts.map((row) => row.amount)),
      perTreeIncentive: tree.per_tree_incentive,
      currentMilestone: current,
      currentMonth: monthOf(current),
    },
    flags: records.flags.map((row) => ({
      id: row.id,
      status: row.status,
      reasonText: row.reason_text,
      reasonHash: row.reason_hash,
      resolutionNote: row.resolution_note,
      openedAt: row.opened_at?.toISOString() ?? null,
      openedTxHash: row.opened_tx,
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      resolvedTxHash: row.resolved_tx,
    })),
  };
};

/** trees §1 `viewer`. */
export const toViewer = (
  isPlanter: boolean,
  flag: { eligible: boolean; blockedBy: string | null },
  records: ViewerRecords,
) => ({
  isPlanter,
  liveSubmissions: records.liveSubmissions.map((row) => ({
    id: row.id,
    kind: row.kind,
    milestone: row.milestone,
    month: monthOf(row.milestone),
    status: row.status,
  })),
  flag,
  pendingFlag:
    records.pendingFlag === undefined
      ? null
      : {
          id: records.pendingFlag.id,
          reasonText: records.pendingFlag.reason_text,
          reasonHash: records.pendingFlag.reason_hash,
          createdAt: records.pendingFlag.created_at.toISOString(),
        },
});
