import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';

// trees.md §1: the tree page's reads. Ids travel as text (REG-001).

/** The tree as anyone sees it. Never selects exact_lat or exact_lon: those have their own query (NFR-006). */
const treeReads = (database: Kysely<DB>) => ({
  tree: (treeId: string) =>
    database
      .selectFrom('trees as t')
      .innerJoin('campaigns as c', 'c.address', 't.campaign_address')
      .leftJoin('species as s', 's.code', 'c.species_code')
      .leftJoin('slot_tags as tag', (join) =>
        join
          .onRef('tag.campaign_address', '=', 't.campaign_address')
          .onRef('tag.slot_id', '=', 't.slot_id'),
      )
      .select([
        sql<string>`t.tree_id::text`.as('tree_id'),
        't.status',
        't.slot_id',
        't.planter_address',
        't.planted_at',
        't.planted_tx',
        't.geohash',
        't.replant_deadline',
        't.paused_seconds',
        'c.address as campaign_address',
        'c.title',
        'c.species_code',
        's.english_name as species_name',
        'c.region_name',
        'c.per_tree_incentive',
        'c.time_unit_seconds',
        'tag.code as tag',
      ])
      .where('t.tree_id', '=', treeId)
      .executeTakeFirst(),

  /** FR-054: chain events in chain order, each with the submission behind its evidence hash, when there is one. */
  timeline: (treeId: string) =>
    database
      .selectFrom('tree_events as e')
      .leftJoin('submissions as sub', 'sub.evidence_hash', 'e.evidence_hash')
      .select([
        'e.kind',
        'e.block_time',
        sql<string>`e.block_number::text`.as('block_number'),
        'e.tx_hash',
        'e.evidence_hash',
        'sub.kind as evidence_kind',
        'sub.milestone',
        'sub.policy_score',
        sql<string | null>`sub.keyframe_paths[1]`.as('first_keyframe'),
      ])
      .where('e.tree_id', '=', treeId)
      .orderBy('e.block_number')
      .orderBy('e.log_index')
      .execute(),
});

/** Payouts, forfeits and flags: bounded by one tree's 36-month life, so never paginated. */
const recordReads = (database: Kysely<DB>) => ({
  payouts: (treeId: string) =>
    database
      .selectFrom('milestone_payouts')
      .select(['milestone', 'amount', 'planter_address', 'block_time', 'tx_hash'])
      .where('tree_id', '=', treeId)
      .orderBy('milestone')
      .execute(),

  /** `enforced`: the Chainlink keeper sent this forfeit (FR-244). `exists`, not a join: one keeper transaction can
   *  settle several milestones of a tree, and a join would repeat the row. */
  forfeits: (treeId: string) =>
    database
      .selectFrom('milestone_forfeits as f')
      .select([
        'f.milestone',
        'f.amount',
        'f.block_time',
        'f.tx_hash',
        sql<boolean>`exists (select 1 from public.chainlink_enforcements ce
          where ce.tree_id = f.tree_id and ce.tx_hash = f.tx_hash)`.as('enforced'),
      ])
      .where('f.tree_id', '=', treeId)
      .orderBy('f.milestone')
      .execute(),

  /** FR-244: the keeper's expire of this tree, if it sent one. */
  removalEnforcement: async (treeId: string): Promise<string | null> =>
    (
      await database
        .selectFrom('chainlink_enforcements')
        .select('tx_hash')
        .where('tree_id', '=', treeId)
        .where('kind', '=', 'expire')
        .executeTakeFirst()
    )?.tx_hash ?? null,

  /** FR-058: every flag past pending, oldest first. Pending flags are never public. */
  flags: (treeId: string) =>
    database
      .selectFrom('flags')
      .select([
        'id',
        'status',
        'reason_text',
        'reason_hash',
        'resolution_note',
        'opened_at',
        'opened_tx',
        'resolved_at',
        'resolved_tx',
      ])
      .where('tree_id', '=', treeId)
      .where('status', '<>', 'pending')
      .orderBy('created_at')
      .execute(),
});

/** What only a signed-in caller gets. */
const viewerReads = (database: Kysely<DB>) => ({
  /** FR-053: for the tree's planter, operators and auditors only; the service decides who asks. */
  exactLocation: (treeId: string) =>
    database
      .selectFrom('trees')
      .select(['exact_lat', 'exact_lon'])
      .where('tree_id', '=', treeId)
      .executeTakeFirstOrThrow(),

  contributed: async (campaign: string, wallet: string): Promise<string> =>
    (
      await database
        .selectFrom('contributions')
        .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
        .where('campaign_address', '=', campaign)
        .where('contributor_address', '=', wallet)
        .executeTakeFirstOrThrow()
    ).total,

  /** FR-063: the caller's own submissions for the tree still on their way (at most three, data-spec §6.2). */
  liveSubmissions: (treeId: string, profileId: string) =>
    database
      .selectFrom('submissions')
      .select(['id', 'kind', 'milestone', 'status'])
      .where('tree_id', '=', treeId)
      .where('profile_id', '=', profileId)
      .where('status', 'in', [
        'uploaded',
        'checking',
        'scored',
        'passed',
        'needs_review',
        'attested',
      ])
      .orderBy('created_at')
      .execute(),

  /** FR-060: the caller's newest flag still waiting for its wallet transaction. */
  pendingFlag: (treeId: string, profileId: string) =>
    database
      .selectFrom('flags')
      .select(['id', 'reason_text', 'reason_hash', 'created_at'])
      .where('tree_id', '=', treeId)
      .where('flagger_profile_id', '=', profileId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
});

export const treesRepository = (database: Kysely<DB>) => ({
  ...treeReads(database),
  ...recordReads(database),
  ...viewerReads(database),
});

export type TreesRepository = ReturnType<typeof treesRepository>;

type Rows<Read extends keyof TreesRepository> = Awaited<ReturnType<TreesRepository[Read]>>;

export type TreeRow = NonNullable<Rows<'tree'>>;

export type TreeRecords = {
  timeline: Rows<'timeline'>;
  payouts: Rows<'payouts'>;
  forfeits: Rows<'forfeits'>;
  flags: Rows<'flags'>;
};

export type ViewerRecords = {
  liveSubmissions: Rows<'liveSubmissions'>;
  pendingFlag: Rows<'pendingFlag'>;
};
