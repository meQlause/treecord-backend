import { CHECK_IN_RADIUS_M, MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';
import type { HeldRow, SlotTarget, TreeTarget } from './evidence.repository.js';
import { reasonsOf, targetChecks, type TargetFacts } from './prechecks/prechecks.rules.js';

const monthOf = (milestone: number): number => MILESTONE_DUE_UNITS[milestone] ?? 0;

/** planter.md capture block: the target prechecks, and the live submission holding the target. */
const captureOf = (facts: TargetFacts, held: HeldRow | undefined) => {
  const reasons = reasonsOf(targetChecks(facts));

  return {
    allowed: reasons.length === 0,
    reasons,
    held:
      held === undefined
        ? null
        : {
            id: held.id,
            status: held.status,
            milestone: held.milestone,
            month: monthOf(held.milestone),
            deviceId: held.device_id,
          },
  };
};

const campaignOf = (target: SlotTarget | TreeTarget) => ({
  address: target.address,
  title: target.title,
  regionName: target.region_name,
  regionRadiusM: target.region_radius_m,
});

const regionReference = (target: SlotTarget) =>
  target.region_center_lat === null || target.region_center_lon === null
    ? null
    : {
        kind: 'region',
        lat: target.region_center_lat,
        lon: target.region_center_lon,
        radiusM: target.region_radius_m,
      };

const treeReference = (location: { lat: number | null; lon: number | null } | null) =>
  location === null || location.lat === null || location.lon === null
    ? null
    : { kind: 'tree', lat: location.lat, lon: location.lon, radiusM: CHECK_IN_RADIUS_M };

const challengeOf = (challenge: { code: string; expires_at: Date } | undefined) =>
  challenge === undefined
    ? null
    : {
        code: challenge.code,
        qr: `TCH-${challenge.code}`,
        expiresAt: challenge.expires_at.toISOString(),
      };

export type PlantingTarget = {
  facts: TargetFacts;
  held: HeldRow | undefined;
  slot: SlotTarget;
  slotId: string;
};

export type TreeTargetFacts = {
  facts: TargetFacts;
  held: HeldRow | undefined;
  tree: TreeTarget;
  challenge: { code: string; expires_at: Date } | undefined;
  location: { lat: number | null; lon: number | null } | null;
};

/** §1 for PLANTED: the slot, its region as the reference. */
export const toPlantingTarget = (
  { facts, held, slot, slotId }: PlantingTarget,
  chainTime: Date,
) => ({
  kind: 'PLANTED',
  slotId,
  treeId: slot.planted_tree,
  milestone: 0,
  month: 0,
  campaign: campaignOf(slot),
  tag: facts.issuedTag,
  challenge: null,
  reference: regionReference(slot),
  ...captureOf(facts, held),
  chainTime: chainTime.toISOString(),
});

/** §1 for a tree; `milestone` is the index the payload must sign (FR-103). */
export const toTreeTarget = (target: TreeTargetFacts, chainTime: Date) => {
  const milestone = target.facts.milestone ?? 0;

  return {
    kind: target.facts.kind,
    slotId: null,
    treeId: target.tree.tree_id,
    milestone,
    month: monthOf(milestone),
    campaign: campaignOf(target.tree),
    tag: target.facts.issuedTag,
    challenge: challengeOf(target.challenge),
    reference: treeReference(target.location),
    ...captureOf(target.facts, target.held),
    chainTime: chainTime.toISOString(),
  };
};
