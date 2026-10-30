import { MILESTONE_DUE_UNITS } from '../../generated/frozen/constants.js';
import {
  pipelineOf,
  reasonsOf,
  targetChecks,
  type EvidenceKind,
  type TargetFacts,
} from '../evidence/index.js';
import type { ChallengeRow, LiveRow, SlotRow, TreeRow, UploadRow } from './planter.repository.js';
import { IN_FLIGHT } from './planter.repository.js';
import {
  currentMilestone,
  milestoneAmounts,
  milestoneStates,
  type Settled,
} from './planter.rules.js';

const MS_PER_HOUR = 3_600_000;
// FR-109: a capture must be uploaded within 72 hours
const UPLOAD_WINDOW_HOURS = 72;
const UPLOAD_WINDOW_MS = UPLOAD_WINDOW_HOURS * MS_PER_HOUR;

const monthOf = (milestone: number | null): number | null =>
  milestone === null ? null : (MILESTONE_DUE_UNITS[milestone] ?? null);

const toHeld = (held: LiveRow | undefined) =>
  held === undefined
    ? null
    : {
        id: held.id,
        status: held.status,
        milestone: held.milestone,
        month: monthOf(held.milestone),
        deviceId: held.device_id,
      };

/** planter.md capture block: the target prechecks of one kind, and the live submission holding the target. */
const toCapture = (facts: TargetFacts, held: LiveRow | undefined) => {
  const reasons = reasonsOf(targetChecks({ ...facts, held: held ?? null }));

  return { allowed: reasons.length === 0, reasons, held: toHeld(held) };
};

export type TreeContext = {
  wallet: string;
  chainTime: number;
  settled: Settled;
  /** FR-244: one of its forfeits (or its removal) was sent by the Chainlink keeper. */
  enforced: boolean;
  live: LiveRow[];
  challenge: { id: string; code: string; expires_at: Date } | undefined;
};

/** The facts every capture block of one tree shares. */
const treeFacts = (tree: TreeRow, context: TreeContext): Omit<TargetFacts, 'kind' | 'held'> => ({
  callerWallet: context.wallet,
  target: { label: `Tree #${tree.tree_id}`, planterAddress: tree.planter_address },
  campaignStatus: tree.campaign_status,
  tree: {
    status: tree.status,
    replantDeadline: tree.replant_deadline?.getTime() ?? null,
    plantedAt: tree.planted_at.getTime(),
    pausedSeconds: tree.paused_seconds,
    unitSeconds: tree.unit_seconds,
  },
  milestone: currentMilestone(context.settled),
  chainTime: context.chainTime,
  mirrored: false,
  openChallengeCode: context.challenge?.code ?? null,
  issuedTag: tree.tag,
});

/** FR-083: one block per kind; ALIVE for the current milestone, DEAD and REPLANTED share one in-flight hold. */
const treeCapture = (tree: TreeRow, context: TreeContext) => {
  const facts = treeFacts(tree, context);
  const current = facts.milestone;
  const checkIn = context.live.find((held) => held.kind === 'ALIVE' && held.milestone === current);
  const event = context.live.find(
    (held) =>
      (held.kind === 'DEAD' || held.kind === 'REPLANTED') &&
      (IN_FLIGHT as readonly string[]).includes(held.status),
  );
  const block = (kind: EvidenceKind, held: LiveRow | undefined, mirrored = false) =>
    toCapture({ ...facts, kind, mirrored, held: null }, held);

  return {
    ALIVE: block('ALIVE', checkIn, current !== null && context.settled.paid.includes(current)),
    DEAD: block('DEAD', event),
    REPLANTED: block('REPLANTED', event),
  };
};

/** §1 item. */
export const toTreeItem = (tree: TreeRow, context: TreeContext) => {
  const amounts = milestoneAmounts({
    perTreeIncentive: tree.per_tree_incentive,
    fundingTarget: tree.funding_target,
    incentivesBps: (tree.split as { incentivesBps: number }).incentivesBps,
    treeTarget: tree.tree_target,
  });
  const timing = {
    status: tree.status,
    plantedAt: tree.planted_at.getTime(),
    pausedSeconds: tree.paused_seconds,
    unitSeconds: tree.unit_seconds,
  };

  return {
    treeId: tree.tree_id,
    status: tree.status,
    campaign: {
      address: tree.campaign_address,
      title: tree.title,
      regionName: tree.region_name,
      speciesName: tree.species_name,
    },
    slotId: String(tree.slot_id),
    plantedAt: tree.planted_at.toISOString(),
    replantDeadline: tree.replant_deadline?.toISOString() ?? null,
    tag: tree.tag,
    enforcedByChainlink: context.enforced,
    currentMilestone: currentMilestone(context.settled),
    milestones: milestoneStates(timing, context.settled, context.chainTime).map((window) => ({
      milestone: window.milestone,
      month: window.month,
      amount: amounts[window.milestone],
      state: window.state,
      opensAt: new Date(window.opensAt).toISOString(),
      closesAt: new Date(window.closesAt).toISOString(),
    })),
    capture: treeCapture(tree, context),
    openChallenge:
      context.challenge === undefined
        ? null
        : {
            id: context.challenge.id,
            code: context.challenge.code,
            expiresAt: context.challenge.expires_at.toISOString(),
          },
  };
};

/** §2 item; `tag` is issued before this runs, so it is never null. */
export const toSlotItem = (
  slot: SlotRow,
  tag: { code: string; issued_at: Date },
  held: LiveRow | undefined,
  wallet: string,
) => ({
  campaign: {
    address: slot.campaign_address,
    title: slot.title,
    status: slot.campaign_status,
    regionName: slot.region_name,
    regionRadiusM: slot.region_radius_m,
    speciesName: slot.species_name,
  },
  slotId: String(slot.slot_id),
  kind: slot.kind,
  status: slot.status,
  claimedAt: slot.claimed_at?.toISOString() ?? null,
  tag: { code: tag.code, issuedAt: tag.issued_at.toISOString() },
  capture: toCapture(
    {
      kind: 'PLANTED',
      callerWallet: wallet,
      target: { label: `Slot #${slot.slot_id}`, planterAddress: slot.planter_address },
      campaignStatus: slot.campaign_status,
      tree: null,
      milestone: null,
      chainTime: 0,
      held: null,
      mirrored: false,
      openChallengeCode: null,
      issuedTag: tag.code,
    },
    held,
  ),
});

/** §3 item: the ALIVE block of the tree; the challenge itself never blocks (FR-093). */
export const toChallengeItem = (challenge: ChallengeRow, context: TreeContext) => {
  const current = currentMilestone(context.settled);

  return {
    id: challenge.challenge_id,
    code: challenge.code,
    qr: `TCH-${challenge.code}`,
    issuedAt: challenge.issued_at.toISOString(),
    expiresAt: challenge.expires_at.toISOString(),
    tree: {
      treeId: challenge.tree_id,
      status: challenge.status,
      tag: challenge.tag,
      currentMilestone: current,
      month: monthOf(current),
      campaign: {
        address: challenge.campaign_address,
        title: challenge.title,
        regionName: challenge.region_name,
      },
    },
    capture: treeCapture(challenge, context).ALIVE,
  };
};

type PrecheckRow = { ok: boolean | null; reason: string | null; value: string };

/** FR-112: why a rejected one came back, first that applies: prechecks, then the reviewer, then the policy. */
const rejectionOf = (upload: UploadRow) => {
  if (upload.status !== 'rejected') {
    return null;
  }

  const failed = ((upload.precheck_results ?? []) as PrecheckRow[]).filter(
    (checked) => checked.ok === false,
  );

  if (failed.length > 0) {
    return {
      stage: 'precheck',
      reasons: failed.map((checked) => ({ reason: checked.reason, value: checked.value })),
      note: null,
    };
  }

  return upload.review_note === null
    ? {
        stage: 'policy',
        reasons: upload.reject_reasons.map((reason) => ({ reason, value: null })),
        note: null,
      }
    : { stage: 'operator', reasons: [], note: upload.review_note };
};

/** §4 item: accuracy only, never the coordinates. */
export const toUploadItem = (upload: UploadRow) => ({
  id: upload.id,
  kind: upload.kind,
  milestone: upload.milestone,
  month: monthOf(upload.milestone),
  status: upload.status,
  campaign: {
    address: upload.campaign_address,
    title: upload.title,
    regionName: upload.region_name,
  },
  slotId: upload.slot_id === null ? null : String(upload.slot_id),
  treeId: upload.tree_id,
  capturedAt: upload.captured_at?.toISOString() ?? null,
  uploadBy:
    upload.captured_at === null
      ? null
      : new Date(upload.captured_at.getTime() + UPLOAD_WINDOW_MS).toISOString(),
  durationSec: upload.duration_sec,
  accM: upload.acc,
  deviceId: upload.device_id,
  pipeline: pipelineOf(upload),
  rejection: rejectionOf(upload),
});
