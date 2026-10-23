import { sql, type Insertable, type Kysely, type Selectable } from 'kysely';
import type { DB, Json, RelayerJobKind, RelayerJobs } from '../../generated/db.js';

type JobContext = {
  context_campaign: string | null;
  context_tree_id: string | null;
  context_batch_id: string | null;
  context_submission_id: string | null;
};

export type StoredJob = Selectable<RelayerJobs>;

export type JobKind = RelayerJobKind;

export type JobPayload = Json;

export type JobRow = StoredJob & JobContext;

export const jobsRepository = (database: Kysely<DB>) => ({
  /** jobs §2: one job by id, with the campaign S12 links to, found through its batch or tree when the payload has none. */
  byId: (id: string): Promise<JobRow | undefined> =>
    database
      .selectFrom('relayer_jobs as job')
      .leftJoin('carbon_batches as batch', (join) =>
        join.on(
          sql<boolean>`job.kind = 'set_price' and batch.batch_id = (job.payload->>'batchId')::bigint`,
        ),
      )
      .leftJoin('trees as tree', (join) =>
        join.on(
          sql<boolean>`job.kind = 'resolve_flag' and tree.tree_id = (job.payload->>'treeId')::bigint`,
        ),
      )
      .selectAll('job')
      .select([
        sql<
          string | null
        >`coalesce(job.payload->>'campaign', batch.campaign_address, tree.campaign_address)`.as(
          'context_campaign',
        ),
        sql<string | null>`job.payload->>'treeId'`.as('context_tree_id'),
        sql<string | null>`job.payload->>'batchId'`.as('context_batch_id'),
        sql<string | null>`job.payload->>'submissionId'`.as('context_submission_id'),
      ])
      .where('job.id', '=', id)
      .executeTakeFirst(),

  /** jobs §3.2 R3: the unique key does the work; no row back means the key is taken. */
  insertUnlessKeyTaken: (values: Insertable<RelayerJobs>): Promise<StoredJob | undefined> =>
    database
      .insertInto('relayer_jobs')
      .values(values)
      .onConflict((conflict) => conflict.column('idempotency_key').doNothing())
      .returningAll()
      .executeTakeFirst(),

  /** R4: the job holding the key, locked so two repeats of a failed job cannot both re-arm it. */
  lockByKey: (key: string): Promise<StoredJob> =>
    database
      .selectFrom('relayer_jobs')
      .selectAll()
      .where('idempotency_key', '=', key)
      .forUpdate()
      .executeTakeFirstOrThrow(),

  /** R5: back to pending with the new payload; tx_hash and last_error stay so the worker checks the earlier send. */
  rearm: (id: string, payload: JobPayload): Promise<StoredJob> =>
    database
      .updateTable('relayer_jobs')
      .set({
        status: 'pending',
        payload,
        attempts: 0,
        next_attempt_at: sql<Date>`now()`,
        locked_at: null,
        locked_by: null,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow(),
});

export type JobsRepository = ReturnType<typeof jobsRepository>;
