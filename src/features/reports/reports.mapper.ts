import { MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';
import type { CampaignHeaderRow, EvidenceRow, ReportRecords } from './reports.repository.js';
import { ratioBps } from '../../shared/bps.js';
import { survivalRateBps } from './reports.rules.js';

const monthOf = (milestone: number): number => MILESTONE_DUE_UNITS[milestone] ?? 0;

/** FR-069 row: public columns only (no score, thumbnail or location). */
export const toEvidenceItem = (row: EvidenceRow) => ({
  treeId: row.tree_id,
  kind: row.kind,
  milestone: row.milestone,
  month: row.milestone === null ? null : monthOf(row.milestone),
  at: row.block_time.toISOString(),
  evidenceHash: row.evidence_hash,
  blockNumber: row.block_number,
  txHash: row.tx_hash,
});

/** FR-067: payouts and amounts paid per milestone, always all six. */
const toIncentives = (campaign: CampaignHeaderRow, records: ReportRecords) => {
  const byMilestone = MILESTONE_DUE_UNITS.map((month, milestone) => {
    const row = records.payoutsByMilestone.find((paid) => paid.milestone === milestone);

    return { milestone, month, payouts: row?.payouts ?? 0, amount: row?.amount ?? '0' };
  });
  const paidAmount = byMilestone
    .reduce((sum, row) => sum + BigInt(row.amount), BigInt(0))
    .toString();

  return {
    incentivePool: campaign.incentive_pool,
    paidAmount,
    paidBps: ratioBps(paidAmount, campaign.incentive_pool),
    forfeitedAmount: records.forfeited,
    byMilestone,
  };
};

/** FR-068: the estimate and the issuance are labelled and never summed (FR-211). */
const toCarbon = (campaign: CampaignHeaderRow, records: ReportRecords) => ({
  estimate: {
    label: 'pre-certification',
    estimatedAmount: campaign.estimated_amount,
    method: campaign.estimate_method,
  },
  issued: {
    label: 'issued',
    issuedAmount: records.batches
      .reduce((sum, batch) => sum + BigInt(batch.amount), BigInt(0))
      .toString(),
    retiredAmount: records.retired,
    batches: records.batches.map((batch) => ({
      batchId: batch.batch_id,
      registry: batch.registry,
      vintage: batch.vintage,
      serialStart: batch.serial_start,
      serialEnd: batch.serial_end,
      issuedAmount: batch.amount,
      issuedTxHash: batch.issued_tx,
    })),
  },
});

/** reports.md §1 `report`, without its evidence page. */
export const toReport = (
  generatedAt: Date,
  campaign: CampaignHeaderRow,
  records: ReportRecords,
) => {
  const { average_age_days: averageAgeDays, ...counts } = records.trees;

  return {
    generatedAt: generatedAt.toISOString(),
    campaign: {
      address: campaign.address,
      status: campaign.status,
      title: campaign.title,
      species:
        campaign.species_code === null
          ? null
          : { code: campaign.species_code, name: campaign.species_name },
      region: { name: campaign.region_name, radiusM: campaign.region_radius_m },
      treeTarget: campaign.tree_target,
      commitmentUnits: campaign.commitment_units,
    },
    trees: { ...counts, survivalRateBps: survivalRateBps(counts), averageAgeDays },
    funding: {
      fundingTarget: campaign.funding_target,
      fundedAmount: campaign.funded_amount,
      progressBps: ratioBps(campaign.funded_amount, campaign.funding_target),
      contributors: records.funding.contributors ?? 0,
      refundedAmount: records.funding.refunded ?? '0',
    },
    incentives: toIncentives(campaign, records),
    carbon: toCarbon(campaign, records),
  };
};
