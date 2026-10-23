import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';

// docs/BE/features/evidence.md §1: the facts behind one capture target. Ids are text (REG-001).

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
const HELD_COLUMNS = ['id', 'status', 'milestone', 'device_id'] as const;
const CAMPAIGN_COLUMNS = [
  'c.address',
  'c.title',
  'c.region_name',
  'c.region_radius_m',
  'c.status as campaign_status',
] as const;

/** The planting target: a campaign slot. */
const slotReads = (database: Kysely<DB>) => ({
  slotTarget: (campaign: string, slotId: string) =>
    database
      .selectFrom('campaigns as c')
      .leftJoin('slots as sl', (join) =>
        join.onRef('sl.campaign_address', '=', 'c.address').on('sl.slot_id', '=', Number(slotId)),
      )
      .select([
        ...CAMPAIGN_COLUMNS,
        'c.region_center_lat',
        'c.region_center_lon',
        'sl.slot_id',
        'sl.planter_address',
        sql<string | null>`sl.tree_id::text`.as('planted_tree'),
      ])
      .where('c.address', '=', campaign)
      .executeTakeFirst(),

  /** A tag already issued; only the slot's own planter gets one issued (evidence §1). */
  tagOf: async (campaign: string, slotId: number): Promise<string | null> =>
    (
      await database
        .selectFrom('slot_tags')
        .select('code')
        .where('campaign_address', '=', campaign)
        .where('slot_id', '=', slotId)
        .executeTakeFirst()
    )?.code ?? null,

  livePlanting: (campaign: string, slotId: number) =>
    database
      .selectFrom('submissions')
      .select(HELD_COLUMNS)
      .where('kind', '=', 'PLANTED')
      .where('campaign_address', '=', campaign)
      .where('slot_id', '=', slotId)
      .where('status', 'in', [...LIVE])
      .executeTakeFirst(),
});

/** The other kinds' target: a tree, what settled it, what holds it, and where it stands. */
const treeReads = (database: Kysely<DB>) => ({
  treeTarget: (treeId: string) =>
    database
      .selectFrom('trees as t')
      .innerJoin('campaigns as c', 'c.address', 't.campaign_address')
      .select([
        ...CAMPAIGN_COLUMNS,
        sql<string>`t.tree_id::text`.as('tree_id'),
        't.slot_id',
        't.status',
        't.planter_address',
        't.planted_at',
        't.replant_deadline',
        sql<string>`t.paused_seconds::text`.as('paused_seconds'),
        sql<string>`c.time_unit_seconds::text`.as('unit_seconds'),
      ])
      .where('t.tree_id', '=', treeId)
      .executeTakeFirst(),

  settled: (treeId: string) =>
    Promise.all([
      database
        .selectFrom('milestone_payouts')
        .select('milestone')
        .where('tree_id', '=', treeId)
        .execute(),
      database
        .selectFrom('milestone_forfeits')
        .select('milestone')
        .where('tree_id', '=', treeId)
        .execute(),
    ]),

  liveOnTree: (treeId: string) =>
    database
      .selectFrom('submissions')
      .select([...HELD_COLUMNS, 'kind'])
      .where('tree_id', '=', treeId)
      .where('status', 'in', [...LIVE])
      .execute(),

  /** Open by the server clock: the API wrote `expires_at`. */
  openChallenge: (treeId: string, now: Date) =>
    database
      .selectFrom('challenges')
      .select(['code', 'expires_at'])
      .where('tree_id', '=', treeId)
      .where('fulfilled_submission_id', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst(),

  /** FR-099: the tree's first location: its exact point, else the landed planting's signed GPS. */
  treeLocation: (treeId: string) =>
    database
      .selectFrom('trees as t')
      .leftJoin('submissions as planting', (join) =>
        join
          .onRef('planting.campaign_address', '=', 't.campaign_address')
          .onRef('planting.slot_id', '=', 't.slot_id')
          .on('planting.kind', '=', 'PLANTED')
          .on('planting.status', '=', 'onchain'),
      )
      .select([
        sql<number | null>`coalesce(t.exact_lat, (planting.payload->>'lat')::float8)`.as('lat'),
        sql<number | null>`coalesce(t.exact_lon, (planting.payload->>'lon')::float8)`.as('lon'),
      ])
      .where('t.tree_id', '=', treeId)
      .executeTakeFirstOrThrow(),
});

export { IN_FLIGHT };

export const evidenceRepository = (database: Kysely<DB>) => ({
  ...slotReads(database),
  ...treeReads(database),
});

export type EvidenceRepository = ReturnType<typeof evidenceRepository>;

type Rows<Read extends keyof EvidenceRepository> = Awaited<ReturnType<EvidenceRepository[Read]>>;

export type SlotTarget = NonNullable<Rows<'slotTarget'>>;

export type TreeTarget = NonNullable<Rows<'treeTarget'>>;

export type HeldRow = NonNullable<Rows<'livePlanting'>>;
