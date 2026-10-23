import { toJobSummary } from '../jobs/index.js';
import { currentEstimate, ESTIMATE_MODEL } from './operations.rules.js';

type Job = Parameters<typeof toJobSummary>[0];

type Species = {
  code: string;
  english_name: string;
  est_kg_co2_per_year_mature: string;
  years_to_maturity: number;
};

type Preview = { amount: string; kgPerTree: string; averageMaturityBps: number };

/** §1: without a species there is nothing to compute from, so every figure that depends on it is null. */
const NO_FIGURES = {
  species: null,
  kgCo2PerYearMature: null,
  yearsToMaturity: null,
  kgPerTree: null,
  averageMaturityBps: null,
  previewAmount: null,
};

const figuresOf = (species: Species | undefined, preview: Preview | undefined) =>
  species === undefined || preview === undefined
    ? NO_FIGURES
    : {
        species: { code: species.code, name: species.english_name },
        kgCo2PerYearMature: species.est_kg_co2_per_year_mature,
        yearsToMaturity: species.years_to_maturity,
        kgPerTree: preview.kgPerTree,
        averageMaturityBps: preview.averageMaturityBps,
        previewAmount: preview.amount,
      };

type Anchor = { unassigned: number; rolledOver: number | null; queued: number; available: number };

type EstimateFacts = {
  species: Species | undefined;
  preview: Preview | undefined;
  treeTarget: number;
  removedTrees: number;
  commitmentMonths: number;
  locked: boolean;
};

/** docs/BE/features/operations.md §1, FR-172–FR-177: everything S27 shows except the batch list. */
export const toCampaignOperations = ({
  campaign,
  anchor,
  estimate,
  queuedJobs,
}: {
  campaign: {
    address: string;
    title: string | null;
    status: string;
    claim_deadline: Date;
    estimated_amount: string | null;
    estimate_method: unknown;
  };
  anchor: Anchor;
  estimate: EstimateFacts;
  queuedJobs: Job[];
}) => ({
  campaign: {
    address: campaign.address,
    title: campaign.title,
    status: campaign.status,
    claimDeadline: campaign.claim_deadline.toISOString(),
  },
  anchor: {
    unassignedAnchorSlots: anchor.unassigned,
    rolledOverOpenSlots: anchor.rolledOver,
    queuedSlots: anchor.queued,
    availableSlots: anchor.available,
  },
  estimate: {
    method: ESTIMATE_MODEL,
    ...figuresOf(estimate.species, estimate.preview),
    treeTarget: estimate.treeTarget,
    removedTrees: estimate.removedTrees,
    treeCount: estimate.treeTarget - estimate.removedTrees,
    commitmentMonths: estimate.commitmentMonths,
    label: 'pre-certification',
    current: currentEstimate(campaign.estimated_amount, campaign.estimate_method),
    locked: estimate.locked,
  },
  queuedJobs: queuedJobs.map(toJobSummary),
});
