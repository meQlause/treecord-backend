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

export const auditRepository = (database: Kysely<DB>) => ({
  ...openWrites(database),
  ...sessionReads(database),
});

type AuditRepository = ReturnType<typeof auditRepository>;

type Rows<Read extends keyof AuditRepository> = Awaited<ReturnType<AuditRepository[Read]>>;

export type SessionRow = NonNullable<Rows<'session'>>;

export type SampleRow = Rows<'samples'>[number];

export type ChallengeRow = Rows<'challenges'>[number];
