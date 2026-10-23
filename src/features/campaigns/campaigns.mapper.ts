import type { CampaignCardRow, CampaignRow } from './campaigns.repository.js';
import {
  budget,
  daysLeft,
  fundingDeadlinePassed,
  INCENTIVE_SCHEDULE,
  openAvailable,
  progressBps,
  remainingCap,
  type Split,
} from './campaigns.rules.js';

/** Claims the chain has not answered yet: all of them, and the viewer's own. */
export type QueuedClaims = { total: number; own: number; ownLatestJobId: string | null };

/** The signed-in caller, as far as the campaign page needs it. */
export type Viewer = { role: string; wallet_address: string | null };

// scalar subqueries, so each may come back null
export type WalletFigures = {
  contributed: string | null;
  refunded: string | null;
  held: number | null;
};

/** campaigns §1 item: the S03 card. Species and region names are null for a campaign created without metadata. */
export const toCampaignCard = (row: CampaignCardRow, now: Date) => ({
  address: row.address,
  status: row.status,
  title: row.title,
  species: row.species_code === null ? null : { code: row.species_code, name: row.species_name },
  region: { name: row.region_name },
  treeTarget: row.tree_target,
  commitmentUnits: row.commitment_units,
  fundingTarget: row.funding_target,
  fundedAmount: row.funded_amount,
  progressBps: progressBps(row.funded_amount, row.funding_target),
  fundingDeadline: row.funding_deadline.toISOString(),
  daysLeft: daysLeft(row.status, row.funding_deadline, now),
  fundingDeadlinePassed: fundingDeadlinePassed(row.status, row.funding_deadline, now),
});

/** campaigns §2 `campaign`. */
export const toCampaignPage = (row: CampaignRow, now: Date, queued: QueuedClaims) => {
  const card = toCampaignCard(row, now);
  const split = row.split as Split;
  const claimDeadlinePassed = now > row.claim_deadline;

  return {
    address: card.address,
    chainId: row.chain_id,
    status: card.status,
    title: card.title,
    species: card.species,
    region: { name: row.region_name, radiusM: row.region_radius_m },
    treeTarget: card.treeTarget,
    commitmentUnits: card.commitmentUnits,
    fundingTarget: card.fundingTarget,
    fundedAmount: card.fundedAmount,
    progressBps: card.progressBps,
    fundingDeadline: card.fundingDeadline,
    claimDeadline: row.claim_deadline.toISOString(),
    daysLeft: card.daysLeft,
    fundingDeadlinePassed: card.fundingDeadlinePassed,
    claimDeadlinePassed,
    split,
    budget: budget(row.funding_target, split),
    incentiveSchedule: INCENTIVE_SCHEDULE,
    slots: {
      anchor: row.anchor_slots,
      open: row.open_slots,
      planted: row.planted ?? 0,
      openAvailable: openAvailable({
        openSlots: row.open_slots,
        taken: row.open_taken ?? 0,
        queued: queued.total,
        claimDeadlinePassed,
      }),
    },
  };
};

/** campaigns §2 `viewer`: the caller's own figures; `claim` only for a planter with a wallet (D06). */
export const toViewer = (
  row: CampaignRow,
  viewer: Viewer,
  figures: WalletFigures | null,
  queued: QueuedClaims,
) => ({
  role: viewer.role,
  walletAddress: viewer.wallet_address,
  contributedAmount: figures?.contributed ?? '0',
  refundedAmount: figures?.refunded ?? '0',
  claim:
    viewer.role === 'planter' && figures !== null
      ? {
          cap: row.per_planter_cap,
          remainingCap: remainingCap({
            cap: row.per_planter_cap,
            held: figures.held ?? 0,
            queued: queued.own,
          }),
          queuedJobId: queued.ownLatestJobId,
        }
      : null,
});
