import { sql, type Insertable, type Kysely, type Updateable } from 'kysely';
import type { DB, Submissions } from '../../generated/db.js';

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
const CAMPAIGNS = 'campaigns as c';
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
      .selectFrom(CAMPAIGNS)
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
      .innerJoin(CAMPAIGNS, 'c.address', 't.campaign_address')
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
      .select(['id', 'code', 'expires_at'])
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

/** §2: the upload link's own writes and reads. */
const linkReads = (database: Kysely<DB>) => ({
  /** FR-132: whoever already holds a video hash, rejected and failed rows included. */
  holderOf: (sha256: string) =>
    database
      .selectFrom('submissions')
      .select([
        'id',
        'profile_id',
        'status',
        'kind',
        'campaign_address',
        'slot_id',
        sql<string | null>`tree_id::text`.as('tree_id'),
        'milestone',
      ])
      .where('video_sha256', '=', sha256)
      .executeTakeFirst(),

  /** §2: the queued row; the video hash key is the uniqueness check (concurrency note). */
  insertQueued: async (values: Insertable<Submissions>): Promise<void> => {
    await database.insertInto('submissions').values(values).execute();
  },
});

/** §3: the submission a submit acts on, and the device its payload names. */
const submitReads = (database: Kysely<DB>) => ({
  /** Locked for the rest of the transaction: a second submit of the same row waits here, then replays. */
  submission: (id: string, lock: boolean) =>
    database
      .selectFrom('submissions')
      .select([
        'id',
        'profile_id',
        'status',
        'kind',
        'campaign_address',
        'slot_id',
        sql<string | null>`tree_id::text`.as('tree_id'),
        'milestone',
        'video_sha256',
        'video_path',
        sql<number | null>`duration_sec::float8`.as('duration_sec'),
        'reject_reasons',
      ])
      .where('id', '=', id)
      .$if(lock, (query) => query.forUpdate())
      .executeTakeFirst(),

  deviceByThumbprint: (thumbprint: string) =>
    database
      .selectFrom('devices')
      .select(['id', 'profile_id', 'revoked_at', 'public_key_jwk'])
      .where('thumbprint', '=', thumbprint)
      .executeTakeFirst(),

  /** §3 concurrency: the checking write runs under a savepoint a rival's live index may unwind. */
  savepoint: async (name: string): Promise<void> => {
    await sql`savepoint ${sql.id(name)}`.execute(database);
  },

  rollbackTo: async (name: string): Promise<void> => {
    await sql`rollback to savepoint ${sql.id(name)}`.execute(database);
  },

  /** §3 step 5: what the submit learned, whatever the outcome. */
  recordSubmit: async (id: string, values: Updateable<Submissions>): Promise<void> => {
    await database.updateTable('submissions').set(values).where('id', '=', id).execute();
  },
});

/** §4: one submission as S21 and S28 show it, with its campaign, landed tree and newest job. */
const detailReads = (database: Kysely<DB>) => ({
  detail: (id: string) =>
    database
      .selectFrom('submissions as sub')
      .innerJoin(CAMPAIGNS, 'c.address', 'sub.campaign_address')
      .leftJoin('trees as landed', (join) =>
        join
          .onRef('landed.campaign_address', '=', 'sub.campaign_address')
          .onRef('landed.slot_id', '=', 'sub.slot_id'),
      )
      .leftJoin('challenges as ch', 'ch.id', 'sub.challenge_id')
      .select([
        'sub.id',
        'sub.profile_id',
        'sub.kind',
        'sub.status',
        'c.address',
        'c.title',
        'c.region_name',
        'c.region_radius_m',
        'sub.slot_id',
        sql<string | null>`coalesce(sub.tree_id, landed.tree_id)::text`.as('tree_id'),
        'sub.milestone',
        'sub.captured_at',
        'sub.received_at',
        'sub.updated_at',
        sql<number | null>`sub.duration_sec::float8`.as('duration_sec'),
        'sub.size_bytes',
        'sub.device_id',
        'sub.video_sha256',
        'sub.payload',
        'sub.canonical',
        'sub.signature',
        'sub.evidence_hash',
        'sub.precheck_results',
        'sub.reject_reasons',
        'sub.policy_decision',
        'sub.policy_score',
        'sub.ai_response',
        'sub.keyframe_paths',
        'sub.attestation',
        'ch.id as challenge_id',
        'ch.code as challenge_code',
        'sub.review_note',
        'sub.reviewed_at',
        'sub.tx_hash',
        'sub.error',
        (builder) =>
          builder
            .selectFrom('relayer_jobs')
            .select('relayer_jobs.id')
            .where('relayer_jobs.idempotency_key', 'in', [
              sql<string>`'score:' || sub.id`,
              sql<string>`'attestation:' || sub.id`,
            ])
            .orderBy('relayer_jobs.created_at', 'desc')
            .limit(1)
            .as('job_id'),
      ])
      .where('sub.id', '=', id)
      .executeTakeFirst(),
});

export { IN_FLIGHT };

/** §5: what an operator's decision reads and writes. */
const reviewWrites = (database: Kysely<DB>) => ({
  /** The submission with what signing needs: its signed point, hash, score and the submitter's wallet. */
  reviewRow: (id: string) =>
    database
      .selectFrom('submissions')
      .innerJoin('profiles', 'profiles.id', 'submissions.profile_id')
      .selectAll('submissions')
      .select([
        'profiles.wallet_address',
        sql<string | null>`submissions.tree_id::text`.as('tree_id'),
      ])
      .where('submissions.id', '=', id)
      .executeTakeFirst(),

  /** The conditional update that settles a race: undefined when the submission had already left review. */
  decide: (id: string, values: Updateable<Submissions>) =>
    database
      .updateTable('submissions')
      .set(values)
      .where('id', '=', id)
      .where('status', '=', 'needs_review')
      .returning('id')
      .executeTakeFirst(),

  /** The challenge an attested check-in carried is fulfilled, as the worker's own pass path does. */
  fulfilChallenge: async (challengeId: string, submissionId: string): Promise<void> => {
    await database
      .updateTable('challenges')
      .set({ fulfilled_submission_id: submissionId })
      .where('id', '=', challengeId)
      .where('fulfilled_submission_id', 'is', null)
      .execute();
  },
});

export const evidenceRepository = (database: Kysely<DB>) => ({
  ...reviewWrites(database),
  ...slotReads(database),
  ...treeReads(database),
  ...linkReads(database),
  ...submitReads(database),
  ...detailReads(database),
});

export type EvidenceRepository = ReturnType<typeof evidenceRepository>;

type Rows<Read extends keyof EvidenceRepository> = Awaited<ReturnType<EvidenceRepository[Read]>>;

export type SlotTarget = NonNullable<Rows<'slotTarget'>>;

export type TreeTarget = NonNullable<Rows<'treeTarget'>>;

export type ReviewRow = NonNullable<Rows<'reviewRow'>>;

export type HeldRow = NonNullable<Rows<'livePlanting'>>;

export type HolderRow = NonNullable<Rows<'holderOf'>>;

export type SubmissionRow = NonNullable<Rows<'submission'>>;

export type DetailRow = NonNullable<Rows<'detail'>>;
