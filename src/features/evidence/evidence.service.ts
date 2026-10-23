import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import type { Storage } from '../../shared/storage/storage.js';
import { auditorRead } from '../audit/index.js';
import { issueSlotTags } from '../planter/index.js';
import {
  loadPlanting,
  loadTree,
  walletOf,
  type Caller,
  type Scope,
  type TagLookup,
} from './evidence.facts.js';
import { toPlantingTarget, toTreeTarget } from './evidence.mapper.js';
import {
  evidenceRepository,
  type EvidenceRepository,
  type HolderRow,
} from './evidence.repository.js';
import type { CaptureTargetQuery, UploadUrlBody } from './evidence.schema.js';
import { linkChecks, reasonsOf } from './prechecks/prechecks.rules.js';
import { toDetail } from './evidence.mapper.js';
import { createReviewService } from './review.service.js';
import { createSubmitService } from './submission.service.js';

type EvidenceDependencies = {
  database: DatabaseClient;
  storage: Pick<Storage, 'presignGet' | 'presignPut' | 'sha256Of'>;
  /** The latest block's time: windows and replant deadlines (REG-009). */
  chainNow: () => Promise<Date>;
  /** The server clock: challenge expiry. */
  now: () => Date;
  randomBytes: (count: number) => Uint8Array;
  attester: Parameters<typeof createReviewService>[0]['attester'];
};

const EVIDENCE_BUCKET = 'evidence';
const UNIQUE_VIOLATION = '23505';

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

const KEYFRAMES_BUCKET = 'keyframes';
// ADR-020: the keyframe links live as long as every other link the API hands out
const LINK_MS = 900_000;

/** §4: the owner, operators, and an auditor whose session sampled the tree (logged through audit first, REG-005);
 *  for anyone else it does not exist (ADR-008). */
const mayRead = async (
  database: Services['database'],
  caller: { id: string; role: string },
  row: { id: string; profile_id: string; tree_id: string | null },
): Promise<boolean> =>
  row.profile_id === caller.id ||
  caller.role === 'operator' ||
  (caller.role === 'auditor' &&
    (await auditorRead(database, {
      auditorId: caller.id,
      treeId: row.tree_id,
      resource: `submission:${row.id}`,
    })));

const detailOf =
  ({ database, repository, storage, now }: Services) =>
  async (caller: { id: string; role: string }, submissionId: string) => {
    const row = await repository.detail(submissionId);
    const operator = caller.role === 'operator';

    if (row === undefined || !(await mayRead(database, caller, row))) {
      throw new DomainError('not_found');
    }

    const urls = await Promise.all(
      row.keyframe_paths.map((path) => storage.presignGet(KEYFRAMES_BUCKET, path)),
    );

    return toDetail(row, {
      keyframes: {
        urls,
        expiresAt: urls.length === 0 ? null : new Date(now().getTime() + LINK_MS).toISOString(),
      },
      withError: operator,
    });
  };

/** docs/BE/features/evidence.md: a planter's evidence, from the capture target onwards. */
export const createEvidenceService = (dependencies: EvidenceDependencies) => {
  const services = { ...dependencies, repository: evidenceRepository(dependencies.database) };

  return {
    captureTarget: captureTargetOf(services),
    uploadUrl: uploadUrlOf(services),
    submit: createSubmitService(dependencies),
    detail: detailOf(services),
    review: createReviewService({ ...dependencies, detail: detailOf(services) }),
  };
};
