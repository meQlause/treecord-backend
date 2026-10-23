import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';

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
      .selectFrom('audit_sessions as s')
      .innerJoin('campaigns as c', 'c.address', 's.campaign_address')
      .select([
        's.id',
        's.status',
        's.campaign_address',
        'c.title',
        'c.region_name',
        's.seed_block_number',
        's.seed_block_hash',
        's.seed',
        sql<string[]>`s.population_tree_ids::text[]`.as('population'),
        's.sample_size',
        's.report_hash',
        's.report',
        's.report_notes',
        's.auditor_profile_id',
        's.created_at',
        's.closed_at',
      ])
      .where('s.id', '=', id)
      .where('s.auditor_profile_id', '=', auditorId)
      .executeTakeFirst(),

  samples: (id: string) =>
    database
      .selectFrom('audit_samples as a')
      .innerJoin('trees as t', 't.tree_id', 'a.tree_id')
      .select([
        'a.position',
        sql<string>`a.tree_id::text`.as('tree_id'),
        't.status',
        'a.finding',
        'a.notes',
        'a.recorded_at',
      ])
      .where('a.session_id', '=', id)
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

export const auditRepository = (database: Kysely<DB>) => ({
  ...openWrites(database),
  ...recordWrites(database),
  ...sessionReads(database),
});

type AuditRepository = ReturnType<typeof auditRepository>;

type Rows<Read extends keyof AuditRepository> = Awaited<ReturnType<AuditRepository[Read]>>;

export type SessionRow = NonNullable<Rows<'session'>>;

export type SampleRow = Rows<'samples'>[number];

export type ChallengeRow = Rows<'challenges'>[number];
