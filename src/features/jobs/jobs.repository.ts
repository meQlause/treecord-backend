import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, RelayerJobs } from '../../generated/db.js';

type JobContext = {
  context_campaign: string | null;
  context_tree_id: string | null;
  context_batch_id: string | null;
  context_submission_id: string | null;
};

export type JobRow = Selectable<RelayerJobs> & JobContext;

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
});

export type JobsRepository = ReturnType<typeof jobsRepository>;
