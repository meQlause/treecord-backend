import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';

// the aliased tables and columns several reads share
const SESSIONS = 'audit_sessions as s';
const SESSION_CREATED = 's.created_at';
const SESSION_REPORT_HASH = 's.report_hash';
const SESSION_SIZE = 's.sample_size';
const SESSION_BLOCK = 's.seed_block_number';
const CAMPAIGN_JOIN = 'campaigns as c';
const SESSION_CAMPAIGN = 's.campaign_address';
const SESSION_AUDITOR = 's.auditor_profile_id';
const SAMPLES = 'audit_samples as a';
const SAMPLE_SESSION = 'a.session_id';

type NewSession = {
  id: string;
  auditorId: string;
  campaign: string;
  block: { number: string; hash: string };
  seed: string;
  population: string[];
  sample: string[];
};

/** §2: what opening a session reads and writes, in its transaction. */
const openWrites = (database: Kysely<DB>) => ({
  campaignExists: async (address: string): Promise<boolean> =>
    (await database
      .selectFrom('campaigns')
      .select('address')
      .where('address', '=', address)
      .executeTakeFirst()) !== undefined,

  /** REG-006, FR-183: every tree but the Removed ones, ascending. */
  population: async (address: string): Promise<string[]> =>
    (
      await database
        .selectFrom('trees')
        .select(sql<string>`tree_id::text`.as('tree_id'))
        .where('campaign_address', '=', address)
        .where('status', '<>', 'removed')
        .orderBy('trees.tree_id')
        .execute()
    ).map((row) => row.tree_id),

  /** The session and one sample row per position, 0 to n − 1. */
  insertSession: async ({
    id,
    auditorId,
    campaign,
    block,
    seed,
    population,
    sample,
  }: NewSession) => {
    await database
      .insertInto('audit_sessions')
      .values({
        id,
        auditor_profile_id: auditorId,
        campaign_address: campaign,
        seed_block_number: block.number,
        seed_block_hash: block.hash,
        seed,
        population_tree_ids: population,
        sample_size: sample.length,
      })
      .execute();
    await database
      .insertInto('audit_samples')
      .values(sample.map((treeId, position) => ({ session_id: id, position, tree_id: treeId })))
      .execute();
  },
});

/** §3: one session as its own auditor reads it; another auditor's does not exist (ADR-008). */
const sessionReads = (database: Kysely<DB>) => ({
  session: (id: string, auditorId: string) =>
    database
      .selectFrom(SESSIONS)
      .innerJoin(CAMPAIGN_JOIN, 'c.address', SESSION_CAMPAIGN)
      .select([
        's.id',
        's.status',
        SESSION_CAMPAIGN,
        'c.title',
        'c.region_name',
        SESSION_BLOCK,
        's.seed_block_hash',
        's.seed',
        sql<string[]>`s.population_tree_ids::text[]`.as('population'),
        SESSION_SIZE,
        SESSION_REPORT_HASH,
        's.report',
        's.report_notes',
        SESSION_AUDITOR,
        SESSION_CREATED,
        's.closed_at',
      ])
      .where('s.id', '=', id)
      .where(SESSION_AUDITOR, '=', auditorId)
      .executeTakeFirst(),

  samples: (id: string) =>
    database
      .selectFrom(SAMPLES)
      .innerJoin('trees as t', 't.tree_id', 'a.tree_id')
      .select([
        'a.position',
        sql<string>`a.tree_id::text`.as('tree_id'),
        't.status',
        'a.finding',
        'a.notes',
        'a.recorded_at',
      ])
      .where(SAMPLE_SESSION, '=', id)
      .orderBy('a.position')
      .execute(),

  /** The session's challenges, newest first, so the first per tree is its latest (FR-187). */
  challenges: (id: string) =>
    database
      .selectFrom('challenges')
      .select([
        'id',
        sql<string>`tree_id::text`.as('tree_id'),
        'code',
        'created_at',
        'expires_at',
        'fulfilled_submission_id',
      ])
      .where('audit_session_id', '=', id)
      .orderBy('created_at', 'desc')
      .execute(),
});

type Lock = 'share' | 'update';

/** §5 and §7: the writes after a session is open, each under the session row's lock. */
const recordWrites = (database: Kysely<DB>) => ({
  /** The caller's session status, locked: `share` for a finding, `update` for the close (§5, §7). */
  lockedStatus: async (id: string, auditorId: string, lock: Lock): Promise<string | undefined> =>
    (
      await database
        .selectFrom('audit_sessions')
        .select('status')
        .where('id', '=', id)
        .where('auditor_profile_id', '=', auditorId)
        .$call((query) => (lock === 'share' ? query.forShare() : query.forUpdate()))
        .executeTakeFirst()
    )?.status,

  /** §5: replaces the tree's earlier finding; undefined when the tree is not in this sample. */
  recordFinding: (
    id: string,
    treeId: string,
    finding: { finding: 'ok' | 'issue' | 'needs_followup'; notes: string | null; recordedAt: Date },
  ) =>
    database
      .updateTable('audit_samples')
      .set({ finding: finding.finding, notes: finding.notes, recorded_at: finding.recordedAt })
      .where('session_id', '=', id)
      .where('tree_id', '=', treeId)
      .returning([
        'position',
        sql<string>`tree_id::text`.as('tree_id'),
        'finding',
        'notes',
        'recorded_at',
      ])
      .executeTakeFirst(),

  /** §7 step 3: the session's challenges in issue order. */
  issuedChallenges: (id: string) =>
    database
      .selectFrom('challenges')
      .select([
        sql<string>`tree_id::text`.as('tree_id'),
        'code',
        'created_at',
        'expires_at',
        'fulfilled_submission_id',
      ])
      .where('audit_session_id', '=', id)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),

  walletOf: async (profileId: string): Promise<string | null> =>
    (
      await database
        .selectFrom('profiles')
        .select('wallet_address')
        .where('id', '=', profileId)
        .executeTakeFirstOrThrow()
    ).wallet_address,

  /** §7 step 5: the report, its hash and the sealed notes, written once. */
  close: async (
    id: string,
    closed: { closedAt: Date; report: object; reportHash: string; notes: object },
  ): Promise<void> => {
    await database
      .updateTable('audit_sessions')
      .set({
        status: 'closed',
        closed_at: closed.closedAt,
        report: JSON.stringify(closed.report),
        report_hash: closed.reportHash,
        report_notes: JSON.stringify(closed.notes),
      })
      .where('id', '=', id)
      .where('status', '=', 'open')
      .execute();
  },
});

/** §6: what a challenge is judged on, and its insert. */
const challengeWrites = (database: Kysely<DB>) => ({
  /** The tree's status, and whether this session sampled it; undefined for an unknown tree. */
  challengeTarget: (id: string, treeId: string) =>
    database
      .selectFrom('trees as t')
      .leftJoin(SAMPLES, (join) =>
        join.onRef('a.tree_id', '=', 't.tree_id').on(SAMPLE_SESSION, '=', id),
      )
      .select(['t.status', sql<boolean>`a.session_id is not null`.as('sampled')])
      .where('t.tree_id', '=', treeId)
      .executeTakeFirst(),

  /** FR-198: the tree's unanswered, unexpired challenge from any session. */
  openChallenge: (treeId: string) =>
    database
      .selectFrom('challenges')
      .select(['id', 'code', 'created_at', 'expires_at'])
      .where('tree_id', '=', treeId)
      .where('fulfilled_submission_id', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .executeTakeFirst(),

  /** Issued now, open for two of the campaign's time units (60 days in production); `challenges_one_open_per_tree`
   *  refuses a second open one (23P01). */
  insertChallenge: async (challenge: {
    sessionId: string;
    treeId: string;
    code: string;
    issuedBy: string;
  }) =>
    (
      await sql<{
        id: string;
        tree_id: string;
        code: string;
        created_at: Date;
        expires_at: Date;
        fulfilled_submission_id: string | null;
      }>`insert into public.challenges (tree_id, code, issued_by_profile_id, audit_session_id, created_at, expires_at)
        select t.tree_id, ${challenge.code}, ${challenge.issuedBy}, ${challenge.sessionId}, now(),
          now() + make_interval(secs => 2 * c.time_unit_seconds)
        from public.trees t join public.campaigns c on c.address = t.campaign_address
        where t.tree_id = ${challenge.treeId}
        returning id, tree_id::text, code, created_at, expires_at, fulfilled_submission_id`.execute(
        database,
      )
    ).rows[0],
});

/** §9: any session, by id alone, for the public reproduction; the caller picks the public fields. */
const reproductionReads = (database: Kysely<DB>) => ({
  publicSession: (id: string) =>
    database
      .selectFrom(SESSIONS)
      .innerJoin(CAMPAIGN_JOIN, 'c.address', SESSION_CAMPAIGN)
      .select([
        's.id',
        's.status',
        SESSION_CAMPAIGN,
        'c.title',
        SESSION_BLOCK,
        's.seed_block_hash',
        's.seed',
        sql<string[]>`s.population_tree_ids::text[]`.as('population'),
        SESSION_SIZE,
        's.report',
        SESSION_REPORT_HASH,
        sql<string[]>`array(select a.tree_id::text from public.audit_samples a
          where a.session_id = s.id order by a.position)`.as('sample'),
      ])
      .where('s.id', '=', id)
      .executeTakeFirst(),
});

/** NFR-053, FR-193, DN-8: who may read sampled evidence, and the log of each read. */
const accessWrites = (database: Kysely<DB>) => ({
  /** The auditor's own session that sampled the tree, whatever its status; the oldest when several did. */
  samplingSession: async (auditorId: string, treeId: string): Promise<string | undefined> =>
    (
      await database
        .selectFrom(SESSIONS)
        .innerJoin(SAMPLES, SAMPLE_SESSION, 's.id')
        .select('s.id')
        .where(SESSION_AUDITOR, '=', auditorId)
        .where('a.tree_id', '=', treeId)
        .orderBy(SESSION_CREATED)
        .limit(1)
        .executeTakeFirst()
    )?.id,

  /** One row per read, committed on its own before any evidence is read. */
  logAccess: async (sessionId: string, auditorId: string, resource: string): Promise<void> => {
    await database
      .insertInto('audit_access_log')
      .values({ session_id: sessionId, auditor_profile_id: auditorId, resource })
      .execute();
  },
});

/** §4: one sampled tree's evidence, as S25 shows it. */
const bundleReads = (database: Kysely<DB>) => ({
  sampleOf: (id: string, treeId: string) =>
    database
      .selectFrom('audit_samples')
      .select(['position', 'finding', 'notes', 'recorded_at'])
      .where('session_id', '=', id)
      .where('tree_id', '=', treeId)
      .executeTakeFirst(),

  bundleTree: (treeId: string) =>
    database
      .selectFrom('trees')
      .select([
        sql<string>`tree_id::text`.as('tree_id'),
        'status',
        'campaign_address',
        'slot_id',
        'planter_address',
        'exact_lat',
        'exact_lon',
        'replant_deadline',
      ])
      .where('tree_id', '=', treeId)
      .executeTakeFirstOrThrow(),

  /** The tree's submissions, its planting found by slot, oldest first: one tree, never paginated. */
  bundleSubmissions: (tree: { tree_id: string; campaign_address: string; slot_id: number }) =>
    database
      .selectFrom('submissions as sub')
      .leftJoin('devices as d', 'd.id', 'sub.device_id')
      .select([
        'sub.id',
        'sub.kind',
        'sub.milestone',
        'sub.status',
        'sub.created_at',
        'sub.video_path',
        'sub.video_sha256',
        'sub.size_bytes',
        sql<number | null>`sub.duration_sec::float8`.as('duration_sec'),
        'sub.keyframe_paths',
        'sub.payload',
        'sub.canonical',
        'sub.signature',
        'sub.evidence_hash',
        'sub.precheck_results',
        'sub.ai_response',
        'sub.policy_decision',
        'sub.policy_score',
        'sub.reject_reasons',
        'sub.review_note',
        'sub.reviewed_at',
        'sub.attestation',
        'sub.tx_hash',
        'd.id as device_id',
        'd.thumbprint',
        'd.revoked_at',
        'd.public_key_jwk',
      ])
      .where((where) =>
        where.or([
          where('sub.tree_id', '=', tree.tree_id),
          where.and([
            where('sub.kind', '=', 'PLANTED'),
            where('sub.campaign_address', '=', tree.campaign_address),
            where('sub.slot_id', '=', tree.slot_id),
          ]),
        ]),
      )
      .orderBy('sub.created_at')
      .execute(),
});

/** §4: the tree's chain records. */
const recordReads = (database: Kysely<DB>) => ({
  events: (treeId: string) =>
    database
      .selectFrom('tree_events')
      .select(['kind', sql<string>`block_number::text`.as('block'), 'block_time', 'tx_hash'])
      .where('tree_id', '=', treeId)
      .orderBy('block_number')
      .orderBy('log_index')
      .execute(),

  payouts: (treeId: string) =>
    database
      .selectFrom('milestone_payouts')
      .select(['milestone', sql<string>`amount::text`.as('amount'), 'tx_hash'])
      .where('tree_id', '=', treeId)
      .orderBy('milestone')
      .execute(),

  forfeitedMilestones: async (treeId: string): Promise<number[]> =>
    (
      await database
        .selectFrom('milestone_forfeits')
        .select('milestone')
        .where('tree_id', '=', treeId)
        .execute()
    ).map((row) => row.milestone),
});

const PREVIEW_SIZE = 21;

/** §1: the auditor's sessions as S23 lists them, newest first. */
const listReads = (database: Kysely<DB>) => ({
  sessionPage: (
    auditorId: string,
    status: 'open' | 'closed' | undefined,
    after: { createdAt: string; id: string } | null,
    take: number,
  ) =>
    database
      .selectFrom(SESSIONS)
      .innerJoin(CAMPAIGN_JOIN, 'c.address', SESSION_CAMPAIGN)
      .select([
        's.id',
        's.status',
        SESSION_CAMPAIGN,
        'c.title',
        SESSION_BLOCK,
        sql<number>`cardinality(s.population_tree_ids)::int`.as('population_size'),
        SESSION_SIZE,
        sql<
          string[]
        >`array(select u::text from unnest(s.population_tree_ids) u order by u limit ${sql.lit(PREVIEW_SIZE)})`.as(
          'population_preview',
        ),
        sql<string[]>`array(select a.tree_id::text from public.audit_samples a
          where a.session_id = s.id order by a.position)`.as('sample'),
        sql<number>`(select count(*)::int from public.audit_samples a
          where a.session_id = s.id and a.finding is not null)`.as('findings_recorded'),
        sql<number>`(select count(*)::int from public.challenges ch
          where ch.audit_session_id = s.id)`.as('challenges_issued'),
        SESSION_REPORT_HASH,
        SESSION_CREATED,
        sql<string>`s.created_at::text`.as('created_cursor'),
        's.closed_at',
      ])
      .where(SESSION_AUDITOR, '=', auditorId)
      .$if(status !== undefined, (query) =>
        query.where('s.status', '=', status as 'open' | 'closed'),
      )
      .$if(after !== null, (query) =>
        query.where(
          sql<boolean>`(s.created_at, s.id) < (${after?.createdAt}::timestamptz, ${after?.id}::uuid)`,
        ),
      )
      .orderBy(SESSION_CREATED, 'desc')
      .orderBy('s.id', 'desc')
      .limit(take)
      .execute(),

  sessionCount: async (auditorId: string, status: 'open' | 'closed' | undefined): Promise<number> =>
    (
      await database
        .selectFrom(SESSIONS)
        .select(sql<number>`count(*)::int`.as('total'))
        .where(SESSION_AUDITOR, '=', auditorId)
        .$if(status !== undefined, (query) =>
          query.where('s.status', '=', status as 'open' | 'closed'),
        )
        .executeTakeFirstOrThrow()
    ).total,
});

export const auditRepository = (database: Kysely<DB>) => ({
  ...listReads(database),
  ...openWrites(database),
  ...bundleReads(database),
  ...recordReads(database),
  ...accessWrites(database),
  ...reproductionReads(database),
  ...challengeWrites(database),
  ...recordWrites(database),
  ...sessionReads(database),
});

export type AuditRepository = ReturnType<typeof auditRepository>;

type Rows<Read extends keyof AuditRepository> = Awaited<ReturnType<AuditRepository[Read]>>;

export type SessionRow = NonNullable<Rows<'session'>>;

export type SessionCardRow = Rows<'sessionPage'>[number];

export type SampleRow = Rows<'samples'>[number];

export type ChallengeRow = Rows<'challenges'>[number];

export type BundleSubmissionRow = Rows<'bundleSubmissions'>[number];
