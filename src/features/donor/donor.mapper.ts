import { ratioBps } from '../../shared/bps.js';
import type { CardFigures, CardRow, FlagRail } from './donor.repository.js';
import { fundingShareBps, planterBudget } from './donor.rules.js';

// FR-211: estimates and reservations are labelled as such, never summed with issued credits
const PRE_CERTIFICATION = 'pre-certification';

const TREE_STATUSES = ['alive', 'flagged', 'dead', 'removed', 'completed'] as const;

type CarbonSummary = { issuedAmount: string; allocatedAmount: string; unfilledAmount: string };

/** §1 totals, carbon card and flags rail. */
export const toDashboard = ({
  walletAddress,
  totals,
  trees,
  carbon,
  flags: [items, counts],
}: {
  walletAddress: string;
  totals: { campaigns: number | null; contributed: string | null; payouts: string | null };
  trees: { planted: number; standing: number };
  carbon: CarbonSummary;
  flags: FlagRail;
}) => ({
  walletAddress,
  totals: {
    campaigns: totals.campaigns ?? 0,
    contributedAmount: totals.contributed ?? '0',
    payoutsReleased: totals.payouts ?? '0',
    treesPlanted: trees.planted,
    survivalRateBps: ratioBps(String(trees.standing), String(trees.planted)),
    // open flags include pending ones (FR-071 rule)
    openFlags: counts.open + counts.pending,
  },
  carbon: {
    issued: {
      label: 'issued',
      issuedAmount: carbon.issuedAmount,
      allocatedAmount: carbon.allocatedAmount,
    },
    unfilled: { label: PRE_CERTIFICATION, unfilledAmount: carbon.unfilledAmount },
  },
  flags: {
    open: counts.open,
    pending: counts.pending,
    items: items.map((row) => ({
      id: row.id,
      treeId: row.tree_id,
      campaign: { address: row.address, title: row.title },
      status: row.status,
      reasonText: row.reason_text,
      createdAt: row.created_at.toISOString(),
      openedAt: row.opened_at?.toISOString() ?? null,
    })),
    total: counts.open + counts.pending,
  },
});

type ByCampaign = { campaign_address: string; amount: string }[];

const amountFor = (rows: ByCampaign, campaign: string): string =>
  rows.find((row) => row.campaign_address === campaign)?.amount ?? '0';

/** §2 card: one supported campaign and the donor's own figures on it. */
export const toCard = (row: CardRow, { money, trees, carbon }: CardFigures) => {
  const [contributed, refunded, payouts] = money;
  const [reservations, holdings] = carbon;
  const contributedAmount = amountFor(contributed, row.address);
  const payoutsReleased = amountFor(payouts, row.address);
  const budget = planterBudget(
    row.incentive_pool,
    row.funded_amount,
    (row.split as { incentivesBps: number }).incentivesBps,
  );
  const reservation = reservations.find((held) => held.campaign_address === row.address);

  return {
    campaign: {
      address: row.address,
      status: row.status,
      title: row.title,
      species:
        row.species_code === null ? null : { code: row.species_code, name: row.species_name },
      region: { name: row.region_name },
      treeTarget: row.tree_target,
      fundingTarget: row.funding_target,
      fundedAmount: row.funded_amount,
      progressBps: ratioBps(row.funded_amount, row.funding_target),
    },
    contributedAmount,
    fundingShareBps: fundingShareBps(contributedAmount, row.funded_amount),
    refundedAmount: amountFor(refunded, row.address),
    trees: Object.fromEntries([
      [
        'planted',
        trees
          .filter((tree) => tree.campaign_address === row.address)
          .reduce((sum, tree) => sum + tree.n, 0),
      ],
      ...TREE_STATUSES.map((status) => [
        status,
        trees.find((tree) => tree.campaign_address === row.address && tree.status === status)?.n ??
          0,
      ]),
    ]),
    payoutsReleased,
    planterBudget: budget,
    releasedBps: ratioBps(payoutsReleased, budget),
    carbon: {
      campaignEstimate:
        row.estimated_amount === null
          ? null
          : { label: PRE_CERTIFICATION, estimatedAmount: row.estimated_amount },
      reservation:
        reservation === undefined
          ? null
          : {
              label: PRE_CERTIFICATION,
              reservedAmount: reservation.reserved_amount,
              allocatedAmount: reservation.allocated_amount,
              unfilledAmount: reservation.unfilled_amount,
              declined: reservation.declined,
            },
      issuedHoldings: { label: 'issued', issuedAmount: amountFor(holdings, row.address) },
    },
  };
};
