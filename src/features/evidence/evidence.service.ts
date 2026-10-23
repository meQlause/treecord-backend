import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import type { Storage } from '../../shared/storage/storage.js';
import { issueSlotTags } from '../planter/index.js';
import {
  toPlantingTarget,
  toTreeTarget,
  type PlantingTarget,
  type TreeTargetFacts,
} from './evidence.mapper.js';
import {
  evidenceRepository,
  IN_FLIGHT,
  type EvidenceRepository,
  type HeldRow,
  type HolderRow,
  type TreeTarget,
} from './evidence.repository.js';
import type { CaptureTargetQuery, UploadUrlBody } from './evidence.schema.js';
import { currentMilestone, linkChecks, reasonsOf } from './prechecks/prechecks.rules.js';

type TreeKind = 'ALIVE' | 'DEAD' | 'REPLANTED';

/** The signed-in planter. */
type Caller = { id: string; wallet_address: string | null };

type EvidenceDependencies = {
  database: DatabaseClient;
  storage: Pick<Storage, 'presignPut'>;
  /** The latest block's time: windows and replant deadlines (REG-009). */
  chainNow: () => Promise<Date>;
  /** The server clock: challenge expiry. */
  now: () => Date;
  randomBytes: (count: number) => Uint8Array;
};

/** How a target's tag is found: issued now for its own planter at the capture target, read only otherwise. */
type TagLookup = (campaign: string, slotId: number, owned: boolean) => Promise<string | null>;

type Scope = { repository: EvidenceRepository; wallet: string; chainTime: Date; tagFor: TagLookup };

const EVIDENCE_BUCKET = 'evidence';
const UNIQUE_VIOLATION = '23505';

const walletOf = (caller: Caller): string => {
  if (caller.wallet_address === null) {
    throw new DomainError('wallet_missing');
  }

  return caller.wallet_address;
};

/** A planting target's facts: the campaign slot. */
const loadPlanting = async (
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
const loadTree = async (
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

/** FR-132: does an existing holder of the hash hold it for this very target? */
const sameTarget = (holder: HolderRow, body: UploadUrlBody): boolean =>
  holder.kind === body.kind &&
  holder.campaign_address === body.campaign &&
  holder.milestone === body.milestone &&
  (body.kind === 'PLANTED'
    ? String(holder.slot_id) === body.slotId
    : holder.tree_id === body.treeId);

/** The hex SHA-256 the planter announced, as the base64 S3 checks the upload against. */
const base64Of = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

/** §2 write: the queued row, its id generated first so the video path can carry it (ADR-020). */
const queuedRow = (caller: Caller, body: UploadUrlBody, submissionId: string) => ({
  id: submissionId,
  profile_id: caller.id,
  campaign_address: body.campaign,
  slot_id: body.kind === 'PLANTED' ? Number(body.slotId) : null,
  tree_id: body.kind === 'PLANTED' ? null : body.treeId,
  kind: body.kind,
  milestone: body.milestone,
  video_sha256: body.sha256,
  size_bytes: body.sizeBytes,
  duration_sec: body.durationSec === null ? null : String(body.durationSec),
  video_path: `${caller.id}/${submissionId}.mp4`,
  status: 'queued' as const,
});

/** FR-132: the caller's own queued row for this video and target is a retry, not a duplicate. */
const isRetry = (
  holder: HolderRow | undefined,
  caller: Caller,
  body: UploadUrlBody,
): holder is HolderRow =>
  holder !== undefined &&
  holder.profile_id === caller.id &&
  holder.status === 'queued' &&
  sameTarget(holder, body);

const hashFact = (holder: HolderRow | undefined, body: UploadUrlBody) =>
  holder === undefined
    ? null
    : { profileId: holder.profile_id, status: holder.status, sameTarget: sameTarget(holder, body) };

type Services = EvidenceDependencies & { repository: EvidenceRepository };

/** §1: a read; a blocked target is a 200 with its reasons. Its own planter's missing tag is issued first. */
const captureTargetOf =
  ({ repository, database, randomBytes, chainNow, now }: Services) =>
  async (caller: Caller, query: CaptureTargetQuery) => {
    const chainTime = await chainNow();
    const tagFor: TagLookup = async (campaign, slotId, owned) =>
      owned
        ? ((await issueSlotTags(database, randomBytes, [{ campaign, slotId }])).get(
            `${campaign}:${slotId}`,
          )?.code ?? null)
        : repository.tagOf(campaign, slotId);
    const scope = { repository, wallet: walletOf(caller), chainTime, tagFor };

    return query.kind === 'PLANTED'
      ? toPlantingTarget(await loadPlanting(scope, query.campaign, query.slotId), chainTime)
      : toTreeTarget(
          await loadTree(scope, { kind: query.kind, treeId: query.treeId, now: now() }),
          chainTime,
        );
  };

/** §2's target: read only, and a tree must be in the campaign the link names. */
const linkTarget = async (scope: Scope, body: UploadUrlBody, now: Date) => {
  if (body.kind === 'PLANTED') {
    return loadPlanting(scope, body.campaign, body.slotId);
  }

  const target = await loadTree(scope, {
    kind: body.kind,
    treeId: body.treeId,
    milestone: body.milestone,
    now,
  });

  if (target.tree.address !== body.campaign) {
    throw new DomainError('not_found');
  }

  return target;
};

/** §2: the link prechecks, then the queued row and a presigned PUT; any reason is a 422 with nothing written. */
const uploadUrlOf = ({ repository, storage, chainNow, now }: Services) => {
  const link = async (submissionId: string, caller: Caller, body: UploadUrlBody) =>
    storage.presignPut({
      bucket: EVIDENCE_BUCKET,
      key: `${caller.id}/${submissionId}.mp4`,
      contentType: body.contentType,
      contentLength: body.sizeBytes,
      sha256Base64: base64Of(body.sha256),
    });
  const replay = async (holder: HolderRow, caller: Caller, body: UploadUrlBody) => ({
    status: 200,
    body: {
      submissionId: holder.id,
      status: 'queued',
      upload: await link(holder.id, caller, body),
      idempotent: true,
    },
  });
  // the video hash key decides a race: the loser re-reads the holder (§2 concurrency)
  const insertOrReplay = async (caller: Caller, body: UploadUrlBody, submissionId: string) => {
    try {
      await repository.insertQueued(queuedRow(caller, body, submissionId));

      return null;
    } catch (error) {
      if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION) {
        throw error;
      }

      const winner = await repository.holderOf(body.sha256);

      if (isRetry(winner, caller, body)) {
        return replay(winner, caller, body);
      }

      throw new DomainError('precheck_failed', { reasons: ['duplicate_video'] });
    }
  };

  return async (caller: Caller, body: UploadUrlBody) => {
    const scope = {
      repository,
      wallet: walletOf(caller),
      chainTime: await chainNow(),
      tagFor: (campaign: string, slotId: number) => repository.tagOf(campaign, slotId),
    };
    const [target, holder] = await Promise.all([
      linkTarget(scope, body, now()),
      repository.holderOf(body.sha256),
    ]);
    const reasons = reasonsOf(
      linkChecks({
        ...target.facts,
        callerProfileId: caller.id,
        durationSec: body.durationSec,
        existingByHash: hashFact(holder, body),
      }),
    );

    if (reasons.length > 0) {
      throw new DomainError('precheck_failed', { reasons });
    }

    if (isRetry(holder, caller, body)) {
      return replay(holder, caller, body);
    }

    const submissionId = randomUUID();

    return (
      (await insertOrReplay(caller, body, submissionId)) ?? {
        status: 201,
        body: { submissionId, status: 'queued', upload: await link(submissionId, caller, body) },
      }
    );
  };
};

/** docs/BE/features/evidence.md: a planter's evidence, from the capture target onwards. */
export const createEvidenceService = (dependencies: EvidenceDependencies) => {
  const services = { ...dependencies, repository: evidenceRepository(dependencies.database) };

  return { captureTarget: captureTargetOf(services), uploadUrl: uploadUrlOf(services) };
};
