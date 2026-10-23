import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';
import type { CampaignStatus } from './donor.schema.js';

// docs/BE/features/donor.md: the donor home, over the campaigns the wallet contributed to (the supported set). Sums
// are numeric read as text (REG-001).

const SUM_AMOUNT = sql<string>`coalesce(sum(amount), 0)::text`;
const CAMPAIGN = 'campaign_address';
const BATCH_CAMPAIGN = 'b.campaign_address';
const COUNT = sql<number>`count(*)::int`;

/** The supported set: every campaign the wallet contributed to, refunded or not. */
const supported = (database: Kysely<DB>, wallet: string) =>
  database
    .selectFrom('contributions')
    .select(CAMPAIGN)
    .distinct()
    .where('contributor_address', '=', wallet);

/** §1: the totals, flags rail and their counts. */
const dashboardReads = (database: Kysely<DB>) => ({
  totals: (wallet: string) =>
    database
      .selectNoFrom((builder) => [
        builder
          .selectFrom('contributions')
          .select(sql<number>`count(distinct campaign_address)::int`.as('n'))
          .where('contributor_address', '=', wallet)
          .as('campaigns'),
        builder
          .selectFrom('contributions')
          .select(SUM_AMOUNT.as('n'))
          .where('contributor_address', '=', wallet)
          .as('contributed'),
        builder
          .selectFrom('milestone_payouts')
          .select(SUM_AMOUNT.as('n'))
          .where(CAMPAIGN, 'in', supported(database, wallet))
          .as('payouts'),
      ])
      .executeTakeFirstOrThrow(),

  treeTotals: (wallet: string) =>
    database
      .selectFrom('trees')
      .select([
        COUNT.as('planted'),
        sql<number>`(count(*) filter (where status in ('alive', 'flagged', 'completed')))::int`.as(
          'standing',
        ),
      ])
      .where(CAMPAIGN, 'in', supported(database, wallet))
      .executeTakeFirstOrThrow(),
});

/** §1: the flags rail. */
const railReads = (database: Kysely<DB>) => ({
  /** FR-075: open flags on supported campaigns, and the caller's own pending ones; never others' drafts. */
  flags: (wallet: string, profileId: string, take: number) => {
    const rail = database
      .selectFrom('flags as f')
      .where((builder) =>
        builder.or([
          builder.and([
            builder('f.status', '=', 'open'),
            builder('f.campaign_address', 'in', supported(database, wallet)),
          ]),
          builder.and([
            builder('f.status', '=', 'pending'),
            builder('f.flagger_profile_id', '=', profileId),
          ]),
        ]),
      );

    return Promise.all([
      rail
        .innerJoin('campaigns as c', 'c.address', 'f.campaign_address')
        .select([
          'f.id',
          sql<string>`f.tree_id::text`.as('tree_id'),
          'c.address',
          'c.title',
          'f.status',
          'f.reason_text',
          'f.created_at',
          'f.opened_at',
        ])
        .orderBy('f.created_at', 'desc')
        .limit(take)
        .execute(),
      rail
        .select([
          sql<number>`(count(*) filter (where f.status = 'open'))::int`.as('open'),
          sql<number>`(count(*) filter (where f.status = 'pending'))::int`.as('pending'),
        ])
        .executeTakeFirstOrThrow(),
    ]);
  },
});

/** §2: one page of supported campaigns, newest first by chain order, with the figures each card shows. */
const cardReads = (database: Kysely<DB>) => ({
  page: (
    wallet: string,
    status: CampaignStatus | undefined,
    after: { block: string; address: string } | null,
    take: number,
  ) => {
    const query = database
      .selectFrom('campaigns as c')
      .leftJoin('species as s', 's.code', 'c.species_code')
      .select([
        'c.address',
        'c.status',
        'c.title',
        'c.species_code',
        's.english_name as species_name',
        'c.region_name',
        'c.tree_target',
        'c.funding_target',
        'c.funded_amount',
        'c.incentive_pool',
        'c.split',
        'c.estimated_amount',
        sql<string>`c.created_block::text`.as('created_block'),
      ])
      .where('c.address', 'in', supported(database, wallet))
      .$if(status !== undefined, (filtered) =>
        filtered.where('c.status', '=', status ?? 'funding'),
      );

    return (
      after === null
        ? query
        : query.where((builder) =>
            builder(
              builder.refTuple('c.created_block', 'c.address'),
              '<',
              builder.tuple(after.block, after.address),
            ),
          )
    )
      .orderBy('c.created_block', 'desc')
      .orderBy('c.address', 'desc')
      .limit(take)
      .execute();
  },

  count: async (wallet: string, status: CampaignStatus | undefined): Promise<number> =>
    (
      await database
        .selectFrom('campaigns')
        .select(COUNT.as('total'))
        .where('address', 'in', supported(database, wallet))
        .$if(status !== undefined, (filtered) => filtered.where('status', '=', status ?? 'funding'))
        .executeTakeFirstOrThrow()
    ).total,
});

/** §2: each figure is one grouped query over the page's campaigns, so the cost follows the page. */
const figureReads = (database: Kysely<DB>) => ({
  money: (wallet: string, campaigns: string[]) =>
    Promise.all([
      database
        .selectFrom('contributions')
        .select([CAMPAIGN, SUM_AMOUNT.as('amount')])
        .where('contributor_address', '=', wallet)
        .where(CAMPAIGN, 'in', campaigns)
        .groupBy(CAMPAIGN)
        .execute(),
      database
        .selectFrom('refunds')
        .select([CAMPAIGN, SUM_AMOUNT.as('amount')])
        .where('contributor_address', '=', wallet)
        .where(CAMPAIGN, 'in', campaigns)
        .groupBy(CAMPAIGN)
        .execute(),
      database
        .selectFrom('milestone_payouts')
        .select([CAMPAIGN, SUM_AMOUNT.as('amount')])
        .where(CAMPAIGN, 'in', campaigns)
        .groupBy(CAMPAIGN)
        .execute(),
    ]),

  treesByStatus: (campaigns: string[]) =>
    database
      .selectFrom('trees')
      .select([CAMPAIGN, 'status', COUNT.as('n')])
      .where(CAMPAIGN, 'in', campaigns)
      .groupBy([CAMPAIGN, 'status'])
      .execute(),

  carbon: (wallet: string, campaigns: string[]) =>
    Promise.all([
      database
        .selectFrom('carbon_reservations')
        .select([
          CAMPAIGN,
          'reserved_amount',
          'allocated_amount',
          sql<string>`(reserved_amount - allocated_amount)::text`.as('unfilled_amount'),
          'declined',
        ])
        .where('holder_address', '=', wallet)
        .where(CAMPAIGN, 'in', campaigns)
        .execute(),
      database
        .selectFrom('carbon_balances as held')
        .innerJoin('carbon_batches as b', 'b.batch_id', 'held.batch_id')
        .select([BATCH_CAMPAIGN, sql<string>`coalesce(sum(held.amount), 0)::text`.as('amount')])
        .where('held.holder_address', '=', wallet)
        .where(BATCH_CAMPAIGN, 'in', campaigns)
        .groupBy(BATCH_CAMPAIGN)
        .execute(),
    ]),
});

export const donorRepository = (database: Kysely<DB>) => ({
  ...dashboardReads(database),
  ...railReads(database),
  ...cardReads(database),
  ...figureReads(database),
});

export type DonorRepository = ReturnType<typeof donorRepository>;

type Rows<Read extends keyof DonorRepository> = Awaited<ReturnType<DonorRepository[Read]>>;

export type CardRow = Rows<'page'>[number];

export type CardFigures = {
  money: Rows<'money'>;
  trees: Rows<'treesByStatus'>;
  carbon: Rows<'carbon'>;
};

export type FlagRail = Rows<'flags'>;
