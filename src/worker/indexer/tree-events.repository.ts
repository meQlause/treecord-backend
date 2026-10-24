// TreeRegistry events into `trees`, `tree_events` and `flags`.
import type { Address, Hex } from 'viem';
import { bytes8ToGeohash, type EvidencePayload } from '../../generated/frozen/evidence.js';
import {
  insert,
  isoFromSeconds,
  maybeOne,
  once,
  one,
  query,
  updateWhere,
  type Json,
  type Queryable,
  type Row,
} from '../worker-db.repository.js';
import {
  eventRow,
  removalReason,
  treeStateAfterDismissal,
  type TimelineEvent,
  type TreeStatus,
} from './apply.rules.js';
import type { ApplyContext } from './apply.service.js';
import { lower, type EventMeta, type IndexedEvent } from './decode.rules.js';

type TreeEvent = Extract<IndexedEvent, { source: 'treeRegistry' }>['event'];
type TreePlantedArgs = Extract<TreeEvent, { eventName: 'TreePlanted' }>['args'];
type FlagResolvedArgs = Extract<TreeEvent, { eventName: 'FlagResolved' }>['args'];
type TreeEventKind =
  | 'planted'
  | 'check_in'
  | 'died'
  | 'replanted'
  | 'removed'
  | 'flagged'
  | 'flag_resolved'
  | 'completed';
type Target = { treeId: number; statusBefore: TreeStatus };
type Handler<Name extends TreeEvent['eventName']> = (
  context: ApplyContext,
  meta: EventMeta,
  event: Extract<TreeEvent, { eventName: Name }>,
  target: Target,
) => Promise<void>;

const recordTreeEvent = async (
  context: ApplyContext,
  meta: EventMeta,
  entry: {
    treeId: number;
    kind: TreeEventKind;
    evidenceHash: Hex | null;
    data: { [key: string]: Json };
  },
): Promise<void> => {
  await once(
    context.db,
    'tree_events',
    {
      tree_id: entry.treeId,
      kind: entry.kind,
      evidence_hash: entry.evidenceHash ? lower(entry.evidenceHash) : null,
      data: entry.data,
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert tree event',
  );
};

const setTree = (database: Queryable, treeId: number, changes: Row, label: string): Promise<void> =>
  updateWhere(
    database,
    label,
    { table: 'trees', where: 'tree_id = $1', values: [treeId] },
    changes,
  );

const geohashOf = (value: Hex): string => {
  try {
    return bytes8ToGeohash(value);
  } catch {
    return value;
  }
};

const onTreePlanted = async (
  context: ApplyContext,
  meta: EventMeta,
  args: TreePlantedArgs,
): Promise<void> => {
  const evidenceHash = lower(args.evidenceHash);
  // exact GPS stays off-chain: take it from the planting submission with the same evidence hash
  const planting = await maybeOne<{ payload: Json }>(
    context.db,
    'load planting submission',
    "select payload from public.submissions where evidence_hash = $1 and kind = 'PLANTED' limit 1",
    [evidenceHash],
  );
  const payload = planting?.payload as EvidencePayload | null | undefined;
  const treeId = Number(args.treeId);

  await insert(
    context.db,
    'upsert tree',
    { table: 'trees', conflict: ['tree_id'] },
    {
      tree_id: treeId,
      campaign_address: lower(args.campaign),
      slot_id: Number(args.slotId),
      planter_address: lower(args.planter),
      planted_at: isoFromSeconds(args.plantedAt),
      geohash: geohashOf(args.geohash),
      exact_lat: payload?.lat ?? null,
      exact_lon: payload?.lon ?? null,
      latest_evidence_hash: evidenceHash,
      planted_tx: meta.txHash,
    },
  );
  await recordTreeEvent(context, meta, {
    treeId,
    kind: 'planted',
    evidenceHash,
    data: { slotId: args.slotId.toString() },
  });
};

/** Links the oldest pending flag the API created with this reason hash, or keeps a row for an on-chain-only flag. */
const openFlag = async (
  context: ApplyContext,
  meta: EventMeta,
  treeId: number,
  flag: { flagger: Address; reasonHash: Hex },
): Promise<void> => {
  const openedAt = await context.blockTime(meta.blockNumber);
  const pending = await maybeOne<{ id: string }>(
    context.db,
    'find pending flag',
    `select id from public.flags
     where tree_id = $1 and reason_hash = $2 and status = 'pending'
     order by created_at asc
     limit 1`,
    [treeId, lower(flag.reasonHash)],
  );

  if (pending) {
    await updateWhere(
      context.db,
      'open flag',
      { table: 'flags', where: 'id = $1', values: [pending.id] },
      { status: 'open', opened_tx: meta.txHash, opened_at: openedAt },
    );

    return;
  }

  const tree = await one<{ campaign_address: string }>(
    context.db,
    'load flagged tree',
    'select campaign_address from public.trees where tree_id = $1',
    [treeId],
  );

  await once(
    context.db,
    'flags',
    {
      tree_id: treeId,
      campaign_address: tree.campaign_address,
      flagger_address: lower(flag.flagger),
      reason_text: '(flagged on-chain without a reason submitted to the app)',
      reason_hash: lower(flag.reasonHash),
      status: 'open',
      opened_tx: meta.txHash,
      opened_at: openedAt,
    },
    'insert on-chain flag',
  );
};

const onTreeFlagged: Handler<'TreeFlagged'> = async (context, meta, event, target) => {
  const { flagger, reasonHash } = event.args;

  // remember the status the flag interrupted, so a dismissal can restore it; a replay keeps the first value
  await recordTreeEvent(context, meta, {
    treeId: target.treeId,
    kind: 'flagged',
    evidenceHash: null,
    data: {
      flagger: lower(flagger),
      reasonHash: lower(reasonHash),
      previousStatus: target.statusBefore,
    },
  });
  await setTree(context.db, target.treeId, { status: 'flagged' }, 'mark tree flagged');

  const already = await maybeOne(
    context.db,
    'find linked flag',
    'select id from public.flags where opened_tx = $1 limit 1',
    [meta.txHash],
  );

  if (!already) {
    await openFlag(context, meta, target.treeId, { flagger, reasonHash });
  }
};

const loadTimeline = (database: Queryable, treeId: number): Promise<TimelineEvent[]> =>
  query<TimelineEvent>(
    database,
    'load tree timeline',
    `select kind, data, block_number, log_index from public.tree_events
     where tree_id = $1 order by block_number asc, log_index asc`,
    [treeId],
  );

const restoreAfterDismissal = async (context: ApplyContext, meta: EventMeta, treeId: number) => {
  const restored = treeStateAfterDismissal(await loadTimeline(context.db, treeId), meta);
  const deadline =
    restored.status === 'dead' && restored.replantDeadlineSec !== null
      ? { replant_deadline: isoFromSeconds(BigInt(restored.replantDeadlineSec)) }
      : {};

  await setTree(
    context.db,
    treeId,
    { status: restored.status, paused_seconds: restored.pausedSeconds, ...deadline },
    'restore tree after dismissed flag',
  );
};

const onFlagResolved = async (
  context: ApplyContext,
  meta: EventMeta,
  treeId: number,
  args: FlagResolvedArgs,
): Promise<void> => {
  await recordTreeEvent(context, meta, {
    treeId,
    kind: 'flag_resolved',
    evidenceHash: null,
    data: {
      upheld: args.upheld,
      noteHash: lower(args.noteHash),
      pausedSeconds: args.pausedSeconds.toString(),
    },
  });
  await updateWhere(
    context.db,
    'resolve flag',
    { table: 'flags', where: "tree_id = $1 and status = 'open'", values: [treeId] },
    {
      status: args.upheld ? 'upheld' : 'dismissed',
      note_hash: lower(args.noteHash),
      resolved_tx: meta.txHash,
      resolved_at: await context.blockTime(meta.blockNumber),
    },
  );

  // an upheld flag is followed by TreeRemoved in the same transaction
  if (!args.upheld) {
    await restoreAfterDismissal(context, meta, treeId);
  }
};

/** A tree event that records itself and sets columns of the tree. */
const recordAndSet = async (
  context: ApplyContext,
  meta: EventMeta,
  entry: Omit<Parameters<typeof recordTreeEvent>[2], 'treeId'> & { treeId: number },
  changes: Row,
): Promise<void> => {
  await recordTreeEvent(context, meta, entry);
  await setTree(context.db, entry.treeId, changes, `tree ${entry.kind}`);
};

const HANDLERS: { [Name in Exclude<TreeEvent['eventName'], 'TreePlanted'>]: Handler<Name> } = {
  CheckInRecorded: (context, meta, event, { treeId }) =>
    recordAndSet(
      context,
      meta,
      {
        treeId,
        kind: 'check_in',
        evidenceHash: event.args.evidenceHash,
        data: { checkInCount: event.args.checkInCount },
      },
      {
        check_in_count: event.args.checkInCount,
        latest_evidence_hash: lower(event.args.evidenceHash),
      },
    ),
  TreeDied: (context, meta, event, { treeId }) =>
    recordAndSet(
      context,
      meta,
      {
        treeId,
        kind: 'died',
        evidenceHash: event.args.evidenceHash,
        data: { replantDeadline: event.args.replantDeadline.toString() },
      },
      {
        status: 'dead',
        replant_deadline: isoFromSeconds(event.args.replantDeadline),
        latest_evidence_hash: lower(event.args.evidenceHash),
      },
    ),
  TreeReplanted: (context, meta, event, { treeId }) =>
    recordAndSet(
      context,
      meta,
      { treeId, kind: 'replanted', evidenceHash: event.args.evidenceHash, data: {} },
      {
        status: 'alive',
        replant_deadline: null,
        latest_evidence_hash: lower(event.args.evidenceHash),
      },
    ),
  TreeRemoved: (context, meta, event, { treeId }) =>
    recordAndSet(
      context,
      meta,
      {
        treeId,
        kind: 'removed',
        evidenceHash: null,
        data: { reason: removalReason(event.args.reason) },
      },
      { status: 'removed', replant_deadline: null },
    ),
  TreeFlagged: onTreeFlagged,
  FlagResolved: (context, meta, event, { treeId }) =>
    onFlagResolved(context, meta, treeId, event.args),
  TreeCompleted: (context, meta, _event, { treeId }) =>
    recordAndSet(
      context,
      meta,
      { treeId, kind: 'completed', evidenceHash: null, data: {} },
      { status: 'completed' },
    ),
};

export const applyTreeEvent = async (
  context: ApplyContext,
  meta: EventMeta,
  event: TreeEvent,
): Promise<void> => {
  if (event.eventName === 'TreePlanted') {
    await onTreePlanted(context, meta, event.args);

    return;
  }

  const treeId = Number(event.args.treeId);
  const tree = await maybeOne<{ tree_id: number; status: TreeStatus }>(
    context.db,
    'load tree',
    'select tree_id, status from public.trees where tree_id = $1',
    [treeId],
  );

  if (!tree) {
    context.log.warn({ treeId, event: event.eventName }, 'event for a tree that is not indexed');

    return;
  }

  const handler = HANDLERS[event.eventName] as Handler<typeof event.eventName>;

  await handler(context, meta, event as never, { treeId, statusBefore: tree.status });
};
