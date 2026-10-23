import { z } from 'zod';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';
import {
  toChallengeItem,
  toSlotItem,
  toTreeItem,
  toUploadItem,
  type TreeContext,
} from './planter.mapper.js';
import {
  planterRepository,
  type LiveRow,
  type PlanterRepository,
  type TreeRow,
} from './planter.repository.js';
import { currentMilestone, milestoneStates, survivalPct, tagCode } from './planter.rules.js';
import type { PageQuery, TreesQuery, UploadsQuery } from './planter.schema.js';

/** The signed-in planter. */
type Caller = { id: string; wallet_address: string | null };

type RandomBytes = (count: number) => Uint8Array;

type PlanterDependencies = {
  database: DatabaseClient;
  /** The latest block's time: every window in this feature (REG-009). */
  chainNow: () => Promise<Date>;
  /** The server clock: challenge expiry only (the API wrote `expires_at`). */
  now: () => Date;
  /** CSPRNG bytes for tag codes (NFR-052). */
  randomBytes: RandomBytes;
};

type Lists = PlanterDependencies & { repository: PlanterRepository };

// §5: a code collision is retried with a fresh code, at most three times
const TAG_ATTEMPTS = 3;
const TAG_BYTES = 32;
const UNIQUE_VIOLATION = '23505';

const treeCursor = z.strictObject({ t: z.string().regex(/^[1-9]\d*$/) });
const challengeCursor = z.strictObject({ i: z.uuid() });
const uploadCursor = z.strictObject({ r: z.string().min(1), i: z.uuid() });

const slotKey = (campaign: string, slotId: number): string => `${campaign}:${slotId}`;

const isCodeCollision = (error: unknown): boolean =>
  (error as { code?: unknown }).code === UNIQUE_VIOLATION &&
  (error as { constraint?: unknown }).constraint === 'slot_tags_code_key';

/** A code from fresh bytes; drawing again in the rare case too few bytes were usable. */
const freshCode = (randomBytes: RandomBytes): string => {
  let code: string | null = null;

  while (code === null) {
    code = tagCode(randomBytes(TAG_BYTES));
  }

  return code;
};

/** One slot's tag; a random code that collides with another slot's is drawn again. */
const issueTag = async (
  repository: PlanterRepository,
  randomBytes: RandomBytes,
  { campaign, slotId }: { campaign: string; slotId: number },
  attempt = 1,
): Promise<void> => {
  try {
    await repository.issueTag(campaign, slotId, freshCode(randomBytes));
  } catch (error) {
    if (!isCodeCollision(error) || attempt === TAG_ATTEMPTS) {
      throw error;
    }

    await issueTag(repository, randomBytes, { campaign, slotId }, attempt + 1);
  }
};

/** §5: one tag per slot, issued on first sight; the primary key absorbs a concurrent first load. */
const ensureSlotTags = async (
  repository: PlanterRepository,
  randomBytes: RandomBytes,
  slots: { campaign: string; slotId: number }[],
) => {
  const campaigns = [...new Set(slots.map((slot) => slot.campaign))];
  const issued = async () =>
    new Map(
      (campaigns.length === 0 ? [] : await repository.tagsOf(campaigns)).map((tag) => [
        slotKey(tag.campaign_address, tag.slot_id),
        tag,
      ]),
    );
  const before = await issued();

  for (const slot of slots.filter((each) => !before.has(slotKey(each.campaign, each.slotId)))) {
    await issueTag(repository, randomBytes, slot);
  }

  return issued();
};

const walletOf = (caller: Caller): string => {
  if (caller.wallet_address === null) {
    throw new DomainError('wallet_missing');
  }

  return caller.wallet_address;
};

const rowsOf = <Row extends { tree_id: string | null }>(rows: Row[], treeId: string) =>
  rows.filter((row) => row.tree_id === treeId);

/** Per tree: what settled each milestone, which submissions hold it, and its open challenge. */
const contextsOf = async (
  repository: PlanterRepository,
  trees: TreeRow[],
  { wallet, chainTime, now }: { wallet: string; chainTime: number; now: Date },
): Promise<Map<string, TreeContext>> => {
  const ids = trees.map((tree) => tree.tree_id);

  if (ids.length === 0) {
    return new Map();
  }

  const [[payouts, forfeits], live, challenges] = await Promise.all([
    repository.settled(ids),
    repository.liveOnTrees(ids),
    repository.openChallenges(ids, now),
  ]);

  return new Map(
    ids.map((id) => [
      id,
      {
        wallet,
        chainTime,
        settled: {
          paid: rowsOf(payouts, id).map((row) => row.milestone),
          forfeited: rowsOf(forfeits, id).map((row) => row.milestone),
        },
        live: rowsOf(live, id) as LiveRow[],
        challenge: rowsOf(challenges, id)[0],
      },
    ]),
  );
};

/** §1 summary: Alive trees whose current window holds chain time. */
const openCheckIns = (alive: TreeRow[], contexts: Map<string, TreeContext>, chainTime: number) =>
  alive.filter((tree) => {
    const settled = contexts.get(tree.tree_id)?.settled ?? { paid: [], forfeited: [] };
    const current = currentMilestone(settled);
    const timing = {
      status: tree.status,
      plantedAt: tree.planted_at.getTime(),
      pausedSeconds: tree.paused_seconds,
      unitSeconds: tree.unit_seconds,
    };

    return (
      current !== null && milestoneStates(timing, settled, chainTime)[current]?.state === 'open'
    );
  }).length;

/** §1 summary over all my trees, ignoring the status filter. */
const toSummary = (
  counts: Awaited<ReturnType<PlanterRepository['treeSummary']>>,
  checkIns: number,
) => ({
  treeCount: counts.all ?? 0,
  survivalPct: survivalPct(counts.standing ?? 0, counts.all ?? 0),
  flaggedCount: counts.flagged ?? 0,
  setAsideAmount: counts.set_aside ?? '0',
  paidAmount: counts.paid ?? '0',
  openCheckIns: checkIns,
});

/** §1: my trees by tree id, with the summary over all of them. */
const treeList =
  ({ repository, chainNow, now }: Lists) =>
  async (caller: Caller, { status, cursor, limit }: TreesQuery) => {
    const wallet = walletOf(caller);
    const after = cursor === undefined ? null : decodeCursor(cursor, treeCursor).t;
    const [rows, total, counts, alive, chain] = await Promise.all([
      repository.treePage(wallet, status, after, limit + 1),
      repository.treeCount(wallet, status),
      repository.treeSummary(wallet),
      repository.aliveTimings(wallet),
      chainNow(),
    ]);
    const scope = { wallet, chainTime: chain.getTime(), now: now() };
    const items = rows.slice(0, limit);
    const [contexts, aliveContexts] = await Promise.all([
      contextsOf(repository, items, scope),
      contextsOf(repository, alive, scope),
    ]);
    const last = items.at(-1);

    return {
      items: items.map((tree) => toTreeItem(tree, contexts.get(tree.tree_id) as TreeContext)),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor({ t: last.tree_id }) : null,
      total,
      summary: toSummary(counts, openCheckIns(alive, aliveContexts, scope.chainTime)),
      chainTime: chain.toISOString(),
    };
  };

/** §2: my unplanted slots, each with its tag (issued now when missing) and planting block. */
const slotList =
  ({ repository, randomBytes }: Lists) =>
  async (caller: Caller) => {
    const wallet = walletOf(caller);
    const [slots, plantings] = await Promise.all([
      repository.slots(wallet),
      repository.livePlantings(wallet),
    ]);
    const tags = await ensureSlotTags(
      repository,
      randomBytes,
      slots.map((slot) => ({ campaign: slot.campaign_address, slotId: slot.slot_id })),
    );
    const items = slots.map((slot) =>
      toSlotItem(
        slot,
        tags.get(slotKey(slot.campaign_address, slot.slot_id)) as { code: string; issued_at: Date },
        plantings.find(
          (held) =>
            held.campaign_address === slot.campaign_address && held.slot_id === slot.slot_id,
        ) as LiveRow | undefined,
        wallet,
      ),
    );

    // bounded by product rule, so the whole list (planter §2)
    return { items, nextCursor: null, total: items.length };
  };

/** §3: open challenges, soonest expiry first. */
const challengeList =
  ({ repository, chainNow, now }: Lists) =>
  async (caller: Caller, { cursor, limit }: PageQuery) => {
    const wallet = walletOf(caller);
    const serverNow = now();
    const [rows, chain] = await Promise.all([repository.challenges(wallet, serverNow), chainNow()]);
    const contexts = await contextsOf(repository, rows, {
      wallet,
      chainTime: chain.getTime(),
      now: serverNow,
    });
    const all = rows.map((row) => toChallengeItem(row, contexts.get(row.tree_id) as TreeContext));
    // ponytail: one open challenge per tree keeps this set small, so it is paged in memory; page in SQL past that
    const start =
      cursor === undefined
        ? 0
        : all.findIndex((item) => item.id === decodeCursor(cursor, challengeCursor).i) + 1;
    const items = all.slice(start, start + limit);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        start + limit < all.length && last !== undefined ? encodeCursor({ i: last.id }) : null,
      total: all.length,
      summary: { answerable: all.filter((item) => item.capture.allowed).length },
    };
  };

/** §4: my sent submissions, newest first. No wallet needed: keyed by profile. */
const uploadList =
  ({ repository }: Lists) =>
  async (caller: Caller, { filter, cursor, limit }: UploadsQuery) => {
    const after = cursor === undefined ? null : decodeCursor(cursor, uploadCursor);
    const [rows, counts] = await Promise.all([
      repository.uploadPage(
        caller.id,
        filter,
        after === null ? null : { receivedAt: after.r, id: after.i },
        limit + 1,
      ),
      repository.uploadCounts(caller.id),
    ]);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const totals = { all: counts.all, sent: counts.sent, rejected: counts.rejected };

    return {
      items: items.map(toUploadItem),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ r: last.received_key, i: last.id })
          : null,
      total: totals[filter],
      summary: totals,
    };
  };

/** docs/BE/features/planter.md: the planter workspace lists. */
export const createPlanterService = (dependencies: PlanterDependencies) => {
  const lists = { ...dependencies, repository: planterRepository(dependencies.database) };

  return {
    trees: treeList(lists),
    slots: slotList(lists),
    challenges: challengeList(lists),
    uploads: uploadList(lists),
  };
};
