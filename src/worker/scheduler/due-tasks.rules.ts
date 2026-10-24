// The maintenance calls the contracts leave to "anyone", decided from the mirror at a chain time. Pure.
import {
  MILESTONE_COUNT,
  MILESTONE_DUE_UNITS,
  MILESTONE_WINDOW_UNITS,
} from '../../generated/frozen/constants.js';

export type TreeFact = {
  treeId: number;
  campaign: string;
  status: 'alive' | 'flagged' | 'dead' | 'removed' | 'completed';
  plantedAtSec: number;
  pausedSeconds: number;
  replantDeadlineSec: number | null;
  /** Milestones paid or forfeited. */
  settled: Set<number>;
};

export type CampaignFact = {
  address: string;
  status: 'funding' | 'active' | 'refunding' | 'completed';
  timeUnitSeconds: number;
  commitmentUnits: number;
  claimDeadlineSec: number;
};

export type Task =
  | { kind: 'forfeit'; campaign: string; treeId: number; milestone: number }
  | { kind: 'expireDead'; treeId: number }
  | { kind: 'markCompleted'; treeId: number }
  | { kind: 'completeCampaign'; campaign: string };

export const taskKey = (task: Task): string => {
  if (task.kind === 'forfeit') {
    return `forfeit:${task.treeId}:${task.milestone}`;
  }

  return task.kind === 'completeCampaign'
    ? `complete:${task.campaign}`
    : `${task.kind}:${task.treeId}`;
};

/** Campaign.forfeitMilestone: not while Flagged, window closed (now > closesAt), not settled. */
const forfeits = (tree: TreeFact, unit: number, nowSec: number): Task[] => {
  if (tree.status !== 'alive' && tree.status !== 'dead') {
    return [];
  }

  return Array.from({ length: MILESTONE_COUNT }, (_milestone, index) => index)
    .filter((milestone) => !tree.settled.has(milestone))
    .filter((milestone) => {
      const opensAt =
        tree.plantedAtSec + tree.pausedSeconds + (MILESTONE_DUE_UNITS[milestone] ?? 0) * unit;

      return nowSec > opensAt + MILESTONE_WINDOW_UNITS * unit;
    })
    .map((milestone) => ({
      kind: 'forfeit' as const,
      campaign: tree.campaign,
      treeId: tree.treeId,
      milestone,
    }));
};

const treeTasks = (tree: TreeFact, unit: number, nowSec: number): Task[] => {
  const tasks = forfeits(tree, unit, nowSec);
  const deadlinePassed = tree.replantDeadlineSec !== null && nowSec > tree.replantDeadlineSec;

  // TreeRegistry.expireDead: Dead and now > replantDeadline
  if (tree.status === 'dead' && deadlinePassed) {
    tasks.push({ kind: 'expireDead', treeId: tree.treeId });
  }

  // TreeRegistry.markCompleted: Alive and every milestone settled
  if (tree.status === 'alive' && tree.settled.size >= MILESTONE_COUNT) {
    tasks.push({ kind: 'markCompleted', treeId: tree.treeId });
  }

  return tasks;
};

/**
 * Campaign.complete: every planted tree Completed or Removed, and the commitment period plus the final window has
 * passed since the later of the last planting and the claim deadline.
 */
const campaignCompletes = (campaign: CampaignFact, trees: TreeFact[], nowSec: number): boolean => {
  if (campaign.status !== 'active') {
    return false;
  }

  const own = trees.filter((tree) => tree.campaign === campaign.address);

  if (own.some((tree) => tree.status !== 'completed' && tree.status !== 'removed')) {
    return false;
  }

  const lastPlanted = Math.max(0, ...own.map((tree) => tree.plantedAtSec));
  const start = Math.max(lastPlanted, campaign.claimDeadlineSec);

  return nowSec >= start + (campaign.commitmentUnits + 1) * campaign.timeUnitSeconds;
};

/** Every maintenance call that is due at chain time `nowSec`, mirroring the contracts' conditions. */
export const dueTasks = (campaigns: CampaignFact[], trees: TreeFact[], nowSec: number): Task[] => {
  const byAddress = new Map(campaigns.map((campaign) => [campaign.address, campaign]));
  const forTrees = trees.flatMap((tree) => {
    const campaign = byAddress.get(tree.campaign);

    return campaign ? treeTasks(tree, campaign.timeUnitSeconds, nowSec) : [];
  });
  const forCampaigns = campaigns
    .filter((campaign) => campaignCompletes(campaign, trees, nowSec))
    .map((campaign) => ({ kind: 'completeCampaign' as const, campaign: campaign.address }));

  return [...forTrees, ...forCampaigns];
};
