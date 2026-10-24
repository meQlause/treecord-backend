import { query, type Queryable } from '../worker-db.repository.js';
import type { CampaignFact, TreeFact } from './due-tasks.rules.js';

type CampaignRow = {
  address: string;
  status: CampaignFact['status'];
  time_unit_seconds: number;
  commitment_units: number;
  claim_deadline: string;
};

type TreeRow = {
  tree_id: number;
  campaign_address: string;
  status: TreeFact['status'];
  planted_at: string;
  paused_seconds: number;
  replant_deadline: string | null;
};

const MS_PER_SECOND = 1000;
const seconds = (iso: string): number => Math.floor(Date.parse(iso) / MS_PER_SECOND);

/** Milestones paid or forfeited, per tree. */
const loadSettled = async (
  database: Queryable,
  treeIds: number[],
): Promise<Map<number, Set<number>>> => {
  const settled = new Map<number, Set<number>>();

  if (treeIds.length === 0) {
    return settled;
  }

  const [payouts, forfeits] = await Promise.all(
    ['milestone_payouts', 'milestone_forfeits'].map((table) =>
      query<{ tree_id: number; milestone: number }>(
        database,
        `load ${table}`,
        `select tree_id, milestone from public.${table} where tree_id = any($1::bigint[])`,
        [treeIds],
      ),
    ),
  );

  for (const row of [...(payouts ?? []), ...(forfeits ?? [])]) {
    settled.set(row.tree_id, (settled.get(row.tree_id) ?? new Set<number>()).add(row.milestone));
  }

  return settled;
};

const toCampaignFact = (row: CampaignRow): CampaignFact => ({
  address: row.address,
  status: row.status,
  timeUnitSeconds: Number(row.time_unit_seconds),
  commitmentUnits: row.commitment_units,
  claimDeadlineSec: seconds(row.claim_deadline),
});

const toTreeFact = (row: TreeRow, settled: Map<number, Set<number>>): TreeFact => ({
  treeId: row.tree_id,
  campaign: row.campaign_address,
  status: row.status,
  plantedAtSec: seconds(row.planted_at),
  pausedSeconds: Number(row.paused_seconds),
  replantDeadlineSec: row.replant_deadline ? seconds(row.replant_deadline) : null,
  settled: settled.get(row.tree_id) ?? new Set<number>(),
});

/** The campaigns and trees of this chain the scheduler decides on. */
export const loadFacts = async (
  database: Queryable,
  chainId: number,
): Promise<{ campaigns: CampaignFact[]; trees: TreeFact[] }> => {
  const campaignRows = await query<CampaignRow>(
    database,
    'load campaigns for maintenance',
    `select address, status, time_unit_seconds, commitment_units, claim_deadline
     from public.campaigns
     where chain_id = $1 and status in ('active', 'completed')
     order by address`,
    [chainId],
  );

  if (campaignRows.length === 0) {
    return { campaigns: [], trees: [] };
  }

  const known = new Set(campaignRows.map((row) => row.address));
  const treeRows = (
    await query<TreeRow>(
      database,
      'load trees for maintenance',
      `select tree_id, campaign_address, status, planted_at, paused_seconds, replant_deadline
       from public.trees order by tree_id`,
    )
  ).filter((row) => known.has(row.campaign_address));
  const settled = await loadSettled(
    database,
    treeRows
      .filter((row) => row.status === 'alive' || row.status === 'dead')
      .map((row) => row.tree_id),
  );

  return {
    campaigns: campaignRows.map(toCampaignFact),
    trees: treeRows.map((row) => toTreeFact(row, settled)),
  };
};
