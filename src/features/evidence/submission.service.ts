import { CHECK_IN_RADIUS_M } from '../../generated/frozen/constants.js';
import {
  base64UrlToBytes,
  canonicalize,
  computeEvidenceHash,
  utf8,
  verifyDeviceSignature,
  type EcPublicJwk,
  type EvidencePayload,
} from '../../generated/frozen/evidence.js';
import type { DatabaseClient, DatabaseTransaction } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import type { Storage } from '../../shared/storage/storage.js';
import { enqueue, enqueuedResponse, jobByKey } from '../jobs/index.js';
import { loadPlanting, loadTree, type Caller, type Scope } from './evidence.facts.js';
import {
  evidenceRepository,
  type EvidenceRepository,
  type SubmissionRow,
} from './evidence.repository.js';
import type { SubmitBody } from './evidence.schema.js';
import { reasonsOf, type CheckRow, type Reason } from './prechecks/prechecks.rules.js';
import { submitChecks, type SubmitFacts } from './prechecks/submit.rules.js';

type SubmitDependencies = {
  database: DatabaseClient;
  storage: Pick<Storage, 'sha256Of'>;
  chainNow: () => Promise<Date>;
  now: () => Date;
};

type Payload = SubmitBody['payload'];

/** What step 4 learned outside the transaction. */
type Stored = { chainTime: Date; storedSha256: string; sizeBytes: number };

const EVIDENCE_BUCKET = 'evidence';
const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'live_target';

// §3 concurrency: a rival submission for the same target committed first; its index names the reason
const LIVE_INDEX_REASON: Readonly<Record<string, Reason>> = {
  submissions_one_live_check_in_idx: 'milestone_already_done',
  submissions_one_per_milestone_idx: 'milestone_already_done',
  submissions_one_live_planting_idx: 'slot_already_planted',
  submissions_one_planting_per_slot_idx: 'slot_already_planted',
  submissions_one_inflight_event_idx: 'already_reported',
};

/** §3 step 3: the signed target must be the announced one. */
const mismatchedFields = (row: SubmissionRow, payload: Payload): string[] =>
  [
    ['kind', row.kind === payload.kind],
    ['campaign', row.campaign_address === payload.campaign],
    ['slotId', (row.slot_id === null ? null : String(row.slot_id)) === payload.slotId],
    ['treeId', row.tree_id === payload.treeId],
    ['milestone', row.milestone === payload.milestone],
    ['videoSha256', row.video_sha256 === payload.videoSha256],
  ].flatMap(([field, same]) => (same ? [] : [field as string]));

const rejected = (submissionId: string, reasons: readonly string[]) =>
  new DomainError('precheck_failed', { reasons, submissionId, status: 'rejected' });

/** §3 replay: a rejected submission answers its stored reasons again; anything further along, its score job. */
const replay = async (database: DatabaseClient, row: SubmissionRow) => {
  if (row.status === 'rejected') {
    throw rejected(row.id, row.reject_reasons);
  }

  const job = await jobByKey(database, `score:${row.id}`);

  if (job === undefined) {
    throw new Error(`submission ${row.id} is ${row.status} without its score job`);
  }

  return enqueuedResponse({ job, outcome: 'replayed' });
};

const referenceOf = (lat: number | null, lon: number | null) =>
  lat === null || lon === null ? null : { lat, lon };

/** The signed fields the checks read; a payload signed before tags existed has no tag at all. */
const signedFacts = ({ tag, capturedAt, ...signed }: Payload): SubmitFacts['payload'] => ({
  ...signed,
  capturedAt: Date.parse(capturedAt),
  ...(tag === undefined ? {} : { tag }),
});

/** Checks 1–2: the device the payload names, and whether it signed exactly these bytes. */
const signatureFacts = async (repository: EvidenceRepository, body: SubmitBody) => {
  const device = await repository.deviceByThumbprint(body.payload.deviceKey);
  const verified =
    device !== undefined &&
    (await verifyDeviceSignature(
      device.public_key_jwk as EcPublicJwk,
      utf8(body.canonical),
      body.signature,
    ));

  return {
    deviceId: device?.id ?? null,
    device:
      device === undefined
        ? null
        : { profileId: device.profile_id, revoked: device.revoked_at !== null },
    canonicalMatches: body.canonical === canonicalize(body.payload as EvidencePayload),
    verified,
  };
};

/** Checks 7 and 9–15: the target as signed, its location reference and its open challenge. */
const targetFacts = async (scope: Scope, payload: Payload, now: Date) => {
  if (payload.kind === 'PLANTED') {
    const { facts, slot } = await loadPlanting(scope, payload.campaign, payload.slotId ?? '0');

    return {
      facts,
      reference: referenceOf(slot.region_center_lat, slot.region_center_lon),
      radiusM: slot.region_radius_m,
      challengeId: null,
    };
  }

  const treeId = payload.treeId ?? '0';
  const [{ facts, challenge }, location] = await Promise.all([
    loadTree(scope, { kind: payload.kind, treeId, milestone: payload.milestone, now }),
    // FR-099: the tree's first location, whoever asks; ownership is judged by its own check
    scope.repository.treeLocation(treeId),
  ]);

  return {
    facts,
    reference: referenceOf(location.lat, location.lon),
    radiusM: CHECK_IN_RADIUS_M,
    challengeId:
      challenge !== undefined && payload.challenge === challenge.code ? challenge.id : null,
  };
};

/** §3 step 5: every fact the fifteen checks judge, loaded in one round of reads. */
const loadFacts = async (
  repository: EvidenceRepository,
  {
    caller,
    body,
    row,
    now,
    stored,
  }: { caller: Caller; body: SubmitBody; row: SubmissionRow; now: Date; stored: Stored },
) => {
  const scope: Scope = {
    repository,
    wallet: caller.wallet_address ?? '',
    chainTime: stored.chainTime,
    tagFor: (campaign, slotId) => repository.tagOf(campaign, slotId),
  };
  const [target, signature] = await Promise.all([
    targetFacts(scope, body.payload, now),
    signatureFacts(repository, body),
  ]);
  const facts: SubmitFacts = {
    ...target.facts,
    callerProfileId: caller.id,
    device: signature.device,
    canonicalMatches: signature.canonicalMatches,
    verified: signature.verified,
    storedSha256: stored.storedSha256,
    payload: signedFacts(body.payload),
    now: now.getTime(),
    reference: target.reference,
    radiusM: target.radiusM,
    durationSec: row.duration_sec,
  };

  return { facts, deviceId: signature.deviceId, challengeId: target.challengeId };
};

/** A rival's live index fired: the target was not free after all. */
const takenTarget = (rows: CheckRow[], reason: Reason): CheckRow[] =>
  rows.map((checked) =>
    checked.check === 'target_free'
      ? { ...checked, ok: false, value: 'held by another submission', reason }
      : checked,
  );

type Settled =
  | { kind: 'rejected'; reasons: Reason[] }
  | { kind: 'queued'; response: ReturnType<typeof enqueuedResponse> }
  | { kind: 'replay'; row: SubmissionRow };

/** Passed every check: `checking` plus its score job, under a savepoint the rival's live index may unwind. */
const toChecking = async (
  trx: DatabaseTransaction,
  {
    caller,
    row,
    written,
    challengeId,
  }: { caller: Caller; row: SubmissionRow; written: object; challengeId: string | null },
): Promise<Settled | Reason> => {
  const writes = evidenceRepository(trx);

  await writes.savepoint(SAVEPOINT);

  try {
    await writes.recordSubmit(row.id, {
      ...written,
      status: 'checking',
      challenge_id: challengeId,
    });

    const queued = await enqueue(trx, {
      kind: 'score',
      payload: { submissionId: row.id },
      createdBy: caller.id,
      idempotencyKey: `score:${row.id}`,
    });

    return { kind: 'queued', response: enqueuedResponse(queued) };
  } catch (error) {
    const reason = LIVE_INDEX_REASON[String((error as { constraint?: unknown }).constraint)];

    if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION || reason === undefined) {
      throw error;
    }

    await writes.rollbackTo(SAVEPOINT);

    return reason;
  }
};

/** §3 step 5, one transaction (ADR-004): lock, re-check, judge, write; a checking row never exists without its job. */
const settle = (
  database: DatabaseClient,
  now: () => Date,
  {
    caller,
    submissionId,
    body,
    stored,
  }: { caller: Caller; submissionId: string; body: SubmitBody; stored: Stored },
) =>
  database.transaction().execute(async (trx): Promise<Settled> => {
    const writes = evidenceRepository(trx);
    const row = await writes.submission(submissionId, true);

    // a concurrent submit of this row committed first and released the lock (§3 concurrency)
    if (row === undefined || row.status !== 'queued') {
      return { kind: 'replay', row: row as SubmissionRow };
    }

    const loaded = await loadFacts(writes, { caller, body, row, now: now(), stored });
    let rows = submitChecks(loaded.facts);
    const written = {
      payload: body.payload,
      canonical: body.canonical,
      signature: body.signature,
      evidence_hash: computeEvidenceHash(utf8(body.canonical), base64UrlToBytes(body.signature)),
      captured_at: new Date(body.payload.capturedAt),
      device_id: loaded.deviceId,
      size_bytes: stored.sizeBytes,
      precheck_results: JSON.stringify(rows),
    };

    if (reasonsOf(rows).length === 0) {
      const outcome = await toChecking(trx, {
        caller,
        row,
        written,
        challengeId: loaded.challengeId,
      });

      if (typeof outcome !== 'string') {
        return outcome;
      }

      rows = takenTarget(rows, outcome);
    }

    const reasons = reasonsOf(rows);

    await writes.recordSubmit(row.id, {
      ...written,
      precheck_results: JSON.stringify(rows),
      status: 'rejected',
      reject_reasons: reasons,
    });

    return { kind: 'rejected', reasons };
  });

/** §3 steps 1–3, before any I/O that costs: the owner's row, and whether it is still queued and signed as announced. */
const announcedRow = async (
  repository: EvidenceRepository,
  { caller, submissionId, body }: { caller: Caller; submissionId: string; body: SubmitBody },
): Promise<SubmissionRow> => {
  const row = await repository.submission(submissionId, false);

  if (row === undefined || row.profile_id !== caller.id) {
    throw new DomainError('not_found');
  }

  const fields = row.status === 'queued' ? mismatchedFields(row, body.payload) : [];

  if (fields.length > 0) {
    throw new DomainError('payload_mismatch', { fields });
  }

  return row;
};

/** docs/BE/features/evidence.md §3: run every check and, in one transaction, store the outcome and queue scoring. */
export const createSubmitService = ({ database, storage, chainNow, now }: SubmitDependencies) => {
  const repository = evidenceRepository(database);

  return async (caller: Caller, submissionId: string, body: SubmitBody) => {
    const row = await announcedRow(repository, { caller, submissionId, body });

    if (row.status !== 'queued') {
      return replay(database, row);
    }

    // step 4, outside the transaction: 25 MiB never streams under a row lock
    const [chainTime, object] = await Promise.all([
      chainNow(),
      storage.sha256Of(EVIDENCE_BUCKET, row.video_path ?? ''),
    ]);

    if (object === null) {
      throw new DomainError('video_not_uploaded');
    }

    const stored = { chainTime, storedSha256: object.sha256, sizeBytes: object.sizeBytes };
    const outcome = await settle(database, now, { caller, submissionId, body, stored });

    if (outcome.kind === 'rejected') {
      throw rejected(submissionId, outcome.reasons);
    }

    return outcome.kind === 'replay' ? replay(database, outcome.row) : outcome.response;
  };
};
