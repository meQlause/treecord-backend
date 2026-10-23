import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';

// docs/BE/features/planter.md: the planter's four lists. Ids and amounts are text (REG-001); each per-page figure is
// one query over the page's ids, never one per row.

// column names used three or more times
const CAMPAIGNS_AS_C = 'campaigns as c';
const T_CAMPAIGN_ADDRESS = 't.campaign_address';
const T_PLANTER_ADDRESS = 't.planter_address';
const PLANTER_ADDRESS = 'planter_address';
const SL_CAMPAIGN_ADDRESS = 'sl.campaign_address';
const SUB_CAMPAIGN_ADDRESS = 'sub.campaign_address';
const SUB_SLOT_ID = 'sub.slot_id';
const SUB_STATUS = 'sub.status';
const CAMPAIGN_ADDRESS = 'campaign_address';
const CH_EXPIRES_AT = 'ch.expires_at';
const CAMPAIGN_TITLE = 'c.title';
const REGION = 'c.region_name';
const SPECIES_NAME = 's.english_name as species_name';
const TREE_ID = sql<string>`t.tree_id::text`.as('tree_id');

// live: holds a target (data-spec §6.2); DEAD and REPLANTED in flight are the same set without onchain
const LIVE = [
  'uploaded',
  'checking',
  'scored',
  'passed',
  'needs_review',
  'attested',
  'onchain',
] as const;
const IN_FLIGHT = ['uploaded', 'checking', 'scored', 'passed', 'needs_review', 'attested'] as const;

/** The tree columns a list item and its capture blocks need. */
const trees = (database: Kysely<DB>) =>
  database
    .selectFrom('trees as t')
    .innerJoin(CAMPAIGNS_AS_C, 'c.address', T_CAMPAIGN_ADDRESS)
    .leftJoin('species as s', 's.code', 'c.species_code')
    .leftJoin('slot_tags as tag', (join) =>
      join
        .onRef('tag.campaign_address', '=', T_CAMPAIGN_ADDRESS)
        .onRef('tag.slot_id', '=', 't.slot_id'),
    )
    .select([
      TREE_ID,
      't.status',
      't.slot_id',
      T_PLANTER_ADDRESS,
      't.planted_at',
      't.replant_deadline',
      sql<string>`t.paused_seconds::text`.as('paused_seconds'),
      'c.address as campaign_address',
      CAMPAIGN_TITLE,
      REGION,
      SPECIES_NAME,
      'c.status as campaign_status',
      'c.per_tree_incentive',
      'c.funding_target',
      'c.split',
      'c.tree_target',
      sql<string>`c.time_unit_seconds::text`.as('unit_seconds'),
      'tag.code as tag',
    ]);

/** §1: my trees, by tree id. */
const treeReads = (database: Kysely<DB>) => ({
  treePage: (wallet: string, status: string | undefined, after: string | null, take: number) =>
    trees(database)
      .where(T_PLANTER_ADDRESS, '=', wallet)
      .$if(status !== undefined, (query) => query.where('t.status', '=', status as 'alive'))
      .$if(after !== null, (query) => query.where('t.tree_id', '>', after ?? '0'))
      .orderBy('t.tree_id')
      .limit(take)
      .execute(),

  treeCount: async (wallet: string, status: string | undefined): Promise<number> =>
    (
      await database
        .selectFrom('trees')
        .select(sql<number>`count(*)::int`.as('total'))
        .where(PLANTER_ADDRESS, '=', wallet)
        .$if(status !== undefined, (query) => query.where('status', '=', status as 'alive'))
        .executeTakeFirstOrThrow()
    ).total,

  /** §1 summary over all my trees: counts and money. */
  treeSummary: (wallet: string) =>
    database
      .selectNoFrom((builder) => [
        builder
          .selectFrom('trees')
          .select(sql<number>`count(*)::int`.as('n'))
          .where(PLANTER_ADDRESS, '=', wallet)
          .as('all'),
        builder
          .selectFrom('trees')
          .select(sql<number>`count(*)::int`.as('n'))
          .where(PLANTER_ADDRESS, '=', wallet)
          .where('status', 'in', ['alive', 'flagged', 'completed'])
          .as('standing'),
        builder
          .selectFrom('trees')
          .select(sql<number>`count(*)::int`.as('n'))
          .where(PLANTER_ADDRESS, '=', wallet)
          .where('status', '=', 'flagged')
          .as('flagged'),
        builder
          .selectFrom('trees as t')
          .innerJoin(CAMPAIGNS_AS_C, 'c.address', T_CAMPAIGN_ADDRESS)
          .select(sql<string>`coalesce(sum(c.per_tree_incentive), 0)::text`.as('n'))
          .where(T_PLANTER_ADDRESS, '=', wallet)
          .as('set_aside'),
        builder
          .selectFrom('milestone_payouts')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('n'))
          .where(PLANTER_ADDRESS, '=', wallet)
          .as('paid'),
      ])
      .executeTakeFirstOrThrow(),

  /** §1 openCheckIns: every Alive tree's timing (ponytail: O(my trees); compute the window in SQL past thousands). */
  aliveTimings: (wallet: string) =>
    trees(database).where(T_PLANTER_ADDRESS, '=', wallet).where('t.status', '=', 'alive').execute(),
});

/** Per page: what settles, holds or challenges the listed trees. */
const treeFigureReads = (database: Kysely<DB>) => ({
  settled: (treeIds: string[]) =>
    Promise.all([
      database
        .selectFrom('milestone_payouts')
        .select([sql<string>`tree_id::text`.as('tree_id'), 'milestone'])
        .where('tree_id', 'in', treeIds)
        .execute(),
      database
        .selectFrom('milestone_forfeits')
        .select([sql<string>`tree_id::text`.as('tree_id'), 'milestone'])
        .where('tree_id', 'in', treeIds)
        .execute(),
    ]),

  liveOnTrees: (treeIds: string[]) =>
    database
      .selectFrom('submissions')
      .select([
        sql<string>`tree_id::text`.as('tree_id'),
        'id',
        'kind',
        'status',
        'milestone',
        'device_id',
      ])
      .where('tree_id', 'in', treeIds)
      .where('status', 'in', [...LIVE])
      .execute(),

  /** Open by the server clock: the API wrote `expires_at` (planter §3 "two clocks"). */
  openChallenges: (treeIds: string[], now: Date) =>
    database
      .selectFrom('challenges')
      .select([sql<string>`tree_id::text`.as('tree_id'), 'id', 'code', 'expires_at'])
      .where('tree_id', 'in', treeIds)
      .where('fulfilled_submission_id', 'is', null)
      .where('expires_at', '>', now)
      .execute(),
});

/** §2: my slots without a tree yet, with their live planting submission. */
const slotReads = (database: Kysely<DB>) => ({
  slots: (wallet: string) =>
    database
      .selectFrom('slots as sl')
      .innerJoin(CAMPAIGNS_AS_C, 'c.address', SL_CAMPAIGN_ADDRESS)
      .leftJoin('species as s', 's.code', 'c.species_code')
      .select([
        SL_CAMPAIGN_ADDRESS,
        'sl.slot_id',
        'sl.kind',
        'sl.status',
        'sl.planter_address',
        'sl.claimed_at',
        CAMPAIGN_TITLE,
        'c.status as campaign_status',
        REGION,
        'c.region_radius_m',
        SPECIES_NAME,
      ])
      .where('sl.planter_address', '=', wallet)
      .where('sl.tree_id', 'is', null)
      .orderBy(SL_CAMPAIGN_ADDRESS)
      .orderBy('sl.slot_id')
      .execute(),

  livePlantings: (wallet: string) =>
    database
      .selectFrom('submissions as sub')
      .select([SUB_CAMPAIGN_ADDRESS, SUB_SLOT_ID, 'sub.id', SUB_STATUS, 'sub.device_id'])
      .where('sub.kind', '=', 'PLANTED')
      .where(SUB_STATUS, 'in', [...LIVE])
      .where(SUB_CAMPAIGN_ADDRESS, 'in', (builder) =>
        builder.selectFrom('slots').select(CAMPAIGN_ADDRESS).where(PLANTER_ADDRESS, '=', wallet),
      )
      .execute(),
});

/** §3: open challenges on my trees, soonest expiry first (bounded: one open per tree). */
const challengeReads = (database: Kysely<DB>) => ({
  challenges: (wallet: string, now: Date) =>
    trees(database)
      .innerJoin('challenges as ch', 'ch.tree_id', 't.tree_id')
      .select(['ch.id as challenge_id', 'ch.code', 'ch.created_at as issued_at', CH_EXPIRES_AT])
      .where(T_PLANTER_ADDRESS, '=', wallet)
      .where('ch.fulfilled_submission_id', 'is', null)
      .where(CH_EXPIRES_AT, '>', now)
      .orderBy(CH_EXPIRES_AT)
      .orderBy('ch.id')
      .execute(),
});

/** §4: my sent submissions, newest first; queued rows are the browser's, not this list's. */
const uploadReads = (database: Kysely<DB>) => {
  const mine = (profileId: string) =>
    database
      .selectFrom('submissions as sub')
      .where('sub.profile_id', '=', profileId)
      .where(SUB_STATUS, '<>', 'queued');

  return {
    uploadPage: (
      profileId: string,
      filter: 'all' | 'sent' | 'rejected',
      after: { receivedAt: string; id: string } | null,
      take: number,
    ) =>
      mine(profileId)
        .innerJoin(CAMPAIGNS_AS_C, 'c.address', SUB_CAMPAIGN_ADDRESS)
        .leftJoin('trees as planted', (join) =>
          join
            .onRef('planted.campaign_address', '=', SUB_CAMPAIGN_ADDRESS)
            .onRef('planted.slot_id', '=', SUB_SLOT_ID),
        )
        .select([
          'sub.id',
          'sub.kind',
          'sub.milestone',
          SUB_STATUS,
          'c.address as campaign_address',
          CAMPAIGN_TITLE,
          REGION,
          SUB_SLOT_ID,
          sql<string | null>`coalesce(sub.tree_id, planted.tree_id)::text`.as('tree_id'),
          'sub.captured_at',
          sql<number | null>`sub.duration_sec::float8`.as('duration_sec'),
          sql<number | null>`(sub.payload->>'acc')::float8`.as('acc'),
          'sub.device_id',
          'sub.precheck_results',
          'sub.ai_response',
          'sub.attestation',
          'sub.review_note',
          'sub.reject_reasons',
          sql<string>`to_char(sub.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'received_key',
          ),
        ])
        .$if(filter === 'sent', (query) => query.where(SUB_STATUS, '<>', 'rejected'))
        .$if(filter === 'rejected', (query) => query.where(SUB_STATUS, '=', 'rejected'))
        .$if(after !== null, (query) =>
          query.where((builder) =>
            builder(
              builder.refTuple('sub.received_at', 'sub.id'),
              '<',
              builder.tuple(sql<Date>`${after?.receivedAt}::timestamptz`, after?.id ?? ''),
            ),
          ),
        )
        .orderBy('sub.received_at', 'desc')
        .orderBy('sub.id', 'desc')
        .limit(take)
        .execute(),

    uploadCounts: (profileId: string) =>
      mine(profileId)
        .select([
          sql<number>`count(*)::int`.as('all'),
          sql<number>`(count(*) filter (where sub.status <> 'rejected'))::int`.as('sent'),
          sql<number>`(count(*) filter (where sub.status = 'rejected'))::int`.as('rejected'),
        ])
        .executeTakeFirstOrThrow(),
  };
};

/** §5: tags by slot; the primary key makes issuing idempotent, so two loads issue one tag. */
const tagReads = (database: Kysely<DB>) => ({
  tagsOf: (campaigns: string[]) =>
    database
      .selectFrom('slot_tags')
      .select([CAMPAIGN_ADDRESS, 'slot_id', 'code', 'issued_at'])
      .where(CAMPAIGN_ADDRESS, 'in', campaigns)
      .execute(),

  issueTag: async (campaign: string, slotId: number, code: string): Promise<void> => {
    await database
      .insertInto('slot_tags')
      .values({ campaign_address: campaign, slot_id: slotId, code })
      .onConflict((conflict) => conflict.columns([CAMPAIGN_ADDRESS, 'slot_id']).doNothing())
      .execute();
  },
});

export { IN_FLIGHT };

export const planterRepository = (database: Kysely<DB>) => ({
  ...treeReads(database),
  ...treeFigureReads(database),
  ...slotReads(database),
  ...challengeReads(database),
  ...uploadReads(database),
  ...tagReads(database),
});

export type PlanterRepository = ReturnType<typeof planterRepository>;

type Rows<Read extends keyof PlanterRepository> = Awaited<ReturnType<PlanterRepository[Read]>>;

export type TreeRow = Rows<'treePage'>[number];

export type SlotRow = Rows<'slots'>[number];

export type ChallengeRow = Rows<'challenges'>[number];

export type LiveRow = Rows<'liveOnTrees'>[number];

export type UploadRow = Rows<'uploadPage'>[number];
