import type { HeldRow, EvidenceRepository, TreeTarget } from './evidence.repository.js';
import { IN_FLIGHT } from './evidence.repository.js';
import type { PlantingTarget, TreeTargetFacts } from './evidence.mapper.js';
import { DomainError } from '../../shared/errors.js';
import { currentMilestone } from './prechecks/prechecks.rules.js';

// docs/BE/features/evidence.md §1–§3: the facts behind one target, loaded the same way by the capture target, the
// upload link and the submit.

export type TreeKind = 'ALIVE' | 'DEAD' | 'REPLANTED';

/** The signed-in planter. */
export type Caller = { id: string; wallet_address: string | null };

/** How a target's tag is found: issued now for its own planter at the capture target, read only otherwise. */
export type TagLookup = (
  campaign: string,
  slotId: number,
  owned: boolean,
) => Promise<string | null>;

export type Scope = {
  repository: EvidenceRepository;
  wallet: string;
  chainTime: Date;
  tagFor: TagLookup;
};

export const walletOf = (caller: Caller): string => {
  if (caller.wallet_address === null) {
    throw new DomainError('wallet_missing');
  }

  return caller.wallet_address;
};

/** A planting target's facts: the campaign slot. */
export const loadPlanting = async (
  { repository, wallet, chainTime, tagFor }: Scope,
  campaign: string,
  slotId: string,
): Promise<PlantingTarget> => {
  const slot = await repository.slotTarget(campaign, slotId);

  if (slot === undefined || slot.slot_id === null) {
    throw new DomainError('not_found');
  }

  const [tag, held] = await Promise.all([
    tagFor(campaign, slot.slot_id, slot.planter_address === wallet),
    repository.livePlanting(campaign, slot.slot_id),
  ]);

  return {
    slot,
    slotId,
    held,
    facts: {
      kind: 'PLANTED',
      callerWallet: wallet,
      target: { label: `Slot #${slotId}`, planterAddress: slot.planter_address },
      campaignStatus: slot.campaign_status,
      tree: null,
      milestone: null,
      chainTime: chainTime.getTime(),
      held: held ?? null,
      mirrored: slot.planted_tree !== null,
      openChallengeCode: null,
      issuedTag: tag,
    },
  };
};

/** The live submission holding a tree target: the month's check-in for ALIVE, any DEAD or REPLANTED in flight else. */
const heldFor = (kind: TreeKind, live: (HeldRow & { kind: string })[], milestone: number | null) =>
  live.find((row) =>
    kind === 'ALIVE'
      ? row.kind === 'ALIVE' && row.milestone === milestone
      : (row.kind === 'DEAD' || row.kind === 'REPLANTED') &&
        (IN_FLIGHT as readonly string[]).includes(row.status),
  );

const treeTimingOf = (tree: TreeTarget) => ({
  status: tree.status,
  replantDeadline: tree.replant_deadline?.getTime() ?? null,
  plantedAt: tree.planted_at.getTime(),
  pausedSeconds: tree.paused_seconds,
  unitSeconds: tree.unit_seconds,
});

/** ALIVE checks a milestone: the one the link names, else the tree's current one. Other kinds check none. */
const askedMilestone = (
  kind: TreeKind,
  milestone: number | undefined,
  settled: { paid: number[]; forfeited: number[] },
): number | null => {
  if (kind !== 'ALIVE') {
    return null;
  }

  return milestone ?? currentMilestone(settled);
};

/** A tree target's facts. `milestone` is the one asked for (the link), else the tree's current one (the target). */
export const loadTree = async (
  { repository, wallet, chainTime, tagFor }: Scope,
  {
    kind,
    treeId,
    milestone,
    now,
  }: { kind: TreeKind; treeId: string; milestone?: number; now: Date },
): Promise<TreeTargetFacts> => {
  const tree = await repository.treeTarget(treeId);

  if (tree === undefined) {
    throw new DomainError('not_found');
  }

  const owned = tree.planter_address === wallet;
  const [tag, [payouts, forfeits], live, challenge, location] = await Promise.all([
    tagFor(tree.address, tree.slot_id, owned),
    repository.settled(treeId),
    repository.liveOnTree(treeId),
    repository.openChallenge(treeId, now),
    owned ? repository.treeLocation(treeId) : null,
  ]);
  const paid = payouts.map((row) => row.milestone);
  const asked = askedMilestone(kind, milestone, {
    paid,
    forfeited: forfeits.map((row) => row.milestone),
  });
  const held = heldFor(kind, live, asked);

  return {
    tree,
    held,
    challenge,
    location,
    facts: {
      kind,
      callerWallet: wallet,
      target: { label: `Tree #${treeId}`, planterAddress: tree.planter_address },
      campaignStatus: tree.campaign_status,
      tree: treeTimingOf(tree),
      milestone: asked,
      chainTime: chainTime.getTime(),
      held: held ?? null,
      mirrored: asked !== null && paid.includes(asked),
      openChallengeCode: challenge?.code ?? null,
      issuedTag: tag,
    },
  };
};
