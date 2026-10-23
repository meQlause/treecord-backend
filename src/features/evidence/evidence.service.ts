import { MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { issueSlotTags } from '../planter/index.js';
import {
  evidenceRepository,
  IN_FLIGHT,
  type EvidenceRepository,
  type HeldRow,
  type SlotTarget,
  type TreeTarget,
} from './evidence.repository.js';
import type { CaptureTargetQuery } from './evidence.schema.js';
import {
  currentMilestone,
  reasonsOf,
  targetChecks,
  type TargetFacts,
} from './prechecks/prechecks.rules.js';

/** The kinds whose target is a tree. */
type TreeKind = 'ALIVE' | 'DEAD' | 'REPLANTED';

/** The signed-in planter. */
type Caller = { id: string; wallet_address: string | null };

type EvidenceDependencies = {
  database: DatabaseClient;
  /** The latest block's time: windows and replant deadlines (REG-009). */
  chainNow: () => Promise<Date>;
  /** The server clock: challenge expiry. */
  now: () => Date;
  randomBytes: (count: number) => Uint8Array;
};

// FR-099: a check-in is recorded within 15 m of the tree
const CHECK_IN_RADIUS_M = 15;

const walletOf = (caller: Caller): string => {
  if (caller.wallet_address === null) {
    throw new DomainError('wallet_missing');
  }

  return caller.wallet_address;
};

const monthOf = (milestone: number): number => MILESTONE_DUE_UNITS[milestone] ?? 0;

/** planter.md capture block. */
const captureOf = (facts: Omit<TargetFacts, 'held'>, held: HeldRow | undefined) => {
  const reasons = reasonsOf(
    targetChecks({ ...facts, held: held === undefined ? null : { ...held } }),
  );

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

type TargetScope = {
  repository: EvidenceRepository;
  wallet: string;
  chainTime: Date;
  /** The tag: issued now for the slot's own planter, read only for anyone else (evidence §1). */
  tagFor: (campaign: string, slotId: number, owned: boolean) => Promise<string | null>;
};

/** §1 for PLANTED: the campaign slot, its region as the reference. */
const plantingTarget = async (
  { repository, wallet, chainTime, tagFor }: TargetScope,
  { campaign, slotId }: { campaign: string; slotId: string },
) => {
  const target = await repository.slotTarget(campaign, slotId);

  if (target === undefined || target.slot_id === null) {
    throw new DomainError('not_found');
  }

  const owned = target.planter_address === wallet;
  const [tag, held] = await Promise.all([
    tagFor(campaign, target.slot_id, owned),
    repository.livePlanting(campaign, target.slot_id),
  ]);
  const facts: Omit<TargetFacts, 'held'> = {
    kind: 'PLANTED',
    callerWallet: wallet,
    target: { label: `Slot #${slotId}`, planterAddress: target.planter_address },
    campaignStatus: target.campaign_status,
    tree: null,
    milestone: null,
    chainTime: chainTime.getTime(),
    mirrored: target.planted_tree !== null,
    openChallengeCode: null,
    issuedTag: tag,
  };

  return {
    kind: 'PLANTED',
    slotId,
    treeId: target.planted_tree,
    milestone: 0,
    month: 0,
    campaign: campaignOf(target),
    tag,
    challenge: null,
    reference:
      target.region_center_lat === null || target.region_center_lon === null
        ? null
        : {
            kind: 'region',
            lat: target.region_center_lat,
            lon: target.region_center_lon,
            radiusM: target.region_radius_m,
          },
    ...captureOf(facts, held),
    chainTime: chainTime.toISOString(),
  };
};

/** The live submission holding the target: the month's check-in for ALIVE, any DEAD or REPLANTED in flight else. */
const heldFor = (kind: TreeKind, live: (HeldRow & { kind: string })[], current: number | null) =>
  live.find((row) =>
    kind === 'ALIVE'
      ? row.kind === 'ALIVE' && row.milestone === current
      : (row.kind === 'DEAD' || row.kind === 'REPLANTED') &&
        (IN_FLIGHT as readonly string[]).includes(row.status),
  );

const challengeOf = (challenge: { code: string; expires_at: Date } | undefined) =>
  challenge === undefined
    ? null
    : {
        code: challenge.code,
        qr: `TCH-${challenge.code}`,
        expiresAt: challenge.expires_at.toISOString(),
      };

const treeReference = (location: { lat: number | null; lon: number | null } | null) =>
  location === null || location.lat === null || location.lon === null
    ? null
    : { kind: 'tree', lat: location.lat, lon: location.lon, radiusM: CHECK_IN_RADIUS_M };

/** The capture facts of a tree target. */
const treeFacts = (
  tree: TreeTarget,
  scope: {
    kind: TreeKind;
    wallet: string;
    milestone: number | null;
    chainTime: Date;
    challengeCode: string | null;
    tag: string | null;
  },
): Omit<TargetFacts, 'held'> => ({
  kind: scope.kind,
  callerWallet: scope.wallet,
  target: { label: `Tree #${tree.tree_id}`, planterAddress: tree.planter_address },
  campaignStatus: tree.campaign_status,
  tree: {
    status: tree.status,
    replantDeadline: tree.replant_deadline?.getTime() ?? null,
    plantedAt: tree.planted_at.getTime(),
    pausedSeconds: tree.paused_seconds,
    unitSeconds: tree.unit_seconds,
  },
  milestone: scope.milestone,
  chainTime: scope.chainTime.getTime(),
  mirrored: false,
  openChallengeCode: scope.challengeCode,
  issuedTag: scope.tag,
});

/** §1 for ALIVE, DEAD and REPLANTED: the tree; its own location goes only to its planter (NFR-006). */
const treeTarget = async (
  { repository, wallet, chainTime, tagFor }: TargetScope,
  { kind, treeId }: { kind: TreeKind; treeId: string },
  now: Date,
) => {
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
  const settled = {
    paid: payouts.map((row) => row.milestone),
    forfeited: forfeits.map((row) => row.milestone),
  };
  const current = currentMilestone(settled);
  const held = heldFor(kind, live, current);
  const facts = treeFacts(tree, {
    kind,
    wallet,
    milestone: kind === 'ALIVE' ? current : null,
    chainTime,
    challengeCode: challenge?.code ?? null,
    tag,
  });
  // the index the payload must sign (FR-103): the current milestone for ALIVE, 0 otherwise
  const milestone = facts.milestone ?? 0;

  return {
    kind,
    slotId: null,
    treeId,
    milestone,
    month: monthOf(milestone),
    campaign: campaignOf(tree),
    tag,
    challenge: challengeOf(challenge),
    reference: treeReference(location),
    ...captureOf(facts, held),
    chainTime: chainTime.toISOString(),
  };
};

/** docs/BE/features/evidence.md: a planter's evidence, from the capture target onwards. */
export const createEvidenceService = ({
  database,
  chainNow,
  now,
  randomBytes,
}: EvidenceDependencies) => {
  const repository = evidenceRepository(database);
  const tagFor = async (campaign: string, slotId: number, owned: boolean) =>
    owned
      ? ((await issueSlotTags(database, randomBytes, [{ campaign, slotId }])).get(
          `${campaign}:${slotId}`,
        )?.code ?? null)
      : repository.tagOf(campaign, slotId);

  return {
    /** §1: a read; a blocked target is a 200 with its reasons. */
    captureTarget: async (caller: Caller, query: CaptureTargetQuery) => {
      const scope = { repository, wallet: walletOf(caller), chainTime: await chainNow(), tagFor };

      return query.kind === 'PLANTED'
        ? plantingTarget(scope, query)
        : treeTarget(scope, query, now());
    },
  };
};
