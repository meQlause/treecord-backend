import type { DatabaseClient, DatabaseTransaction } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { enqueue, enqueuedResponse, openSlotCounts } from '../jobs/index.js';
import {
  availableAnchorSlots,
  ESTIMATE_FORMULA,
  ESTIMATE_MODEL,
  estimateCarbon,
  tonnesToUnits,
} from './operations.rules.js';
import { operationsRepository } from './operations.repository.js';
import type { AnchorAssignmentInput, IssuanceInput } from './operations.schema.js';

type Caller = { id: string };

type OperationsDependencies = {
  database: DatabaseClient;
  /** The latest block's time: the claim deadline is judged on it (ADR-015). */
  chainNow: () => Promise<Date>;
  clock: () => Date;
};

const ISSUABLE = ['active', 'completed'];

/** §2–§4: the locked campaign, or 404 before any job is queued for it. */
const lockedCampaign = async (trx: DatabaseTransaction, address: string) => {
  const campaign = await operationsRepository(trx).lockCampaign(address);

  if (campaign === undefined) {
    throw new DomainError('not_found');
  }

  return campaign;
};

const requireActive = (status: string): void => {
  if (status !== 'active') {
    throw new DomainError('campaign_not_active', { status });
  }
};

/** §3: the figures for the campaign as it stands, or undefined when its species is unknown. */
const estimateOf = async (
  trx: DatabaseTransaction,
  campaign: Awaited<ReturnType<typeof lockedCampaign>>,
) => {
  const repository = operationsRepository(trx);
  const species =
    campaign.species_code === null ? undefined : await repository.species(campaign.species_code);

  if (species === undefined) {
    return undefined;
  }

  const inputs = {
    kgCo2PerYearMature: species.est_kg_co2_per_year_mature,
    yearsToMaturity: species.years_to_maturity,
    treeCount: campaign.tree_target - (await repository.removedTrees(campaign.address)),
    commitmentMonths: campaign.commitment_units,
  };

  return {
    ...inputs,
    ...estimateCarbon(inputs),
    species: { code: species.code, name: species.english_name },
  };
};

/** §2, FR-173. */
const assignAnchors =
  ({ database, chainNow }: OperationsDependencies) =>
  async (
    caller: Caller,
    address: string,
    { planter, count }: AnchorAssignmentInput,
    idempotencyKey: string | null,
  ) => {
    const now = await chainNow();

    return database.transaction().execute(async (trx) => {
      const campaign = await lockedCampaign(trx, address);
      // counted after the lock and before this request's own job, so a concurrent assignment is seen
      const slots = await operationsRepository(trx).slotCounts(address);
      const queued = await openSlotCounts(trx, 'anchor_assign', address, null);
      const queuedJob = await enqueue(trx, {
        kind: 'anchor_assign',
        payload: { campaign: address, planter, count },
        createdBy: caller.id,
        idempotencyKey,
      });

      if (queuedJob.outcome === 'replayed') {
        return enqueuedResponse(queuedJob);
      }

      requireActive(campaign.status);

      const available = availableAnchorSlots({
        unassignedAnchors: slots.unassigned_anchors,
        openUnclaimed: slots.open_unclaimed,
        queued: queued.total,
        claimDeadlinePassed: now > campaign.claim_deadline,
      });

      if (count > available) {
        throw new DomainError('not_enough_slots', { available });
      }

      return enqueuedResponse(queuedJob);
    });
  };

/** §3, FR-174: writes the method, never `estimated_amount`. */
const estimate =
  ({ database, clock }: OperationsDependencies) =>
  async (caller: Caller, address: string, idempotencyKey: string | null) =>
    database.transaction().execute(async (trx) => {
      const campaign = await lockedCampaign(trx, address);
      const figures = await estimateOf(trx, campaign);
      const queuedJob = await enqueue(trx, {
        kind: 'estimate',
        // '0' only when species_unknown below refuses, which rolls this job back
        payload: { campaign: address, estimatedAmount: figures?.amount ?? '0' },
        createdBy: caller.id,
        idempotencyKey,
      });

      if (queuedJob.outcome === 'replayed') {
        return enqueuedResponse(queuedJob);
      }

      requireActive(campaign.status);

      if (await operationsRepository(trx).hasBatch(address)) {
        throw new DomainError('estimate_locked');
      }

      if (figures === undefined) {
        throw new DomainError('species_unknown');
      }

      await operationsRepository(trx).writeEstimateMethod(address, {
        model: ESTIMATE_MODEL,
        label: 'pre-certification',
        formula: ESTIMATE_FORMULA,
        ...figures,
        computedAt: clock().toISOString(),
        jobId: queuedJob.job.id,
      });

      return enqueuedResponse(queuedJob);
    });

/** docs/BE/features/operations.md §2–§5: four operator actions that each only queue a job; their effects appear when
 *  the indexer mirrors the events (ADR-015). Each looks its key up before any state check (jobs R2), so a retry gets
 *  its original job even when the campaign changed since; a refusal rolls the queued job back. */
export const createOperationsService = (dependencies: OperationsDependencies) => {
  const { database } = dependencies;

  return {
    assignAnchors: assignAnchors(dependencies),
    estimate: estimate(dependencies),

    /** §4, FR-175: the key is required (the route checks it); the server converts tonnes to units. */
    issue: async (
      caller: Caller,
      address: string,
      issuance: IssuanceInput,
      idempotencyKey: string,
    ) =>
      database.transaction().execute(async (trx) => {
        const campaign = await lockedCampaign(trx, address);
        const { tonnes, ...batch } = issuance;
        const queuedJob = await enqueue(trx, {
          kind: 'issue',
          payload: { campaign: address, ...batch, amount: tonnesToUnits(tonnes) },
          createdBy: caller.id,
          idempotencyKey,
        });

        if (queuedJob.outcome !== 'replayed' && !ISSUABLE.includes(campaign.status)) {
          throw new DomainError('campaign_not_issuable', { status: campaign.status });
        }

        return enqueuedResponse(queuedJob);
      }),

    /** §5, FR-176: only a mirrored batch takes a price. */
    setPrice: async (
      caller: Caller,
      batchId: string,
      usdcPerTonne: string,
      idempotencyKey: string | null,
    ) => {
      if (!(await operationsRepository(database).batchExists(batchId))) {
        throw new DomainError('not_found');
      }

      return database.transaction().execute(async (trx) =>
        enqueuedResponse(
          await enqueue(trx, {
            kind: 'set_price',
            payload: { batchId, usdcPerTonne },
            createdBy: caller.id,
            idempotencyKey,
          }),
        ),
      );
    },
  };
};
