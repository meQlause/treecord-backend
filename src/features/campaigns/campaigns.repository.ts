import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';
import type { CursorPosition } from './campaigns.rules.js';
import type { ListCampaignsQuery } from './campaigns.schema.js';

type Filters = Pick<ListCampaignsQuery, 'status' | 'species' | 'region'>;

type From = ExpressionBuilder<DB & { c: DB['campaigns'] }, 'c'>;

const SPECIES_CODE = 'c.species_code';
const CREATED_BLOCK = 'c.created_block';

// "50%" matches literally: LIKE's own characters are escaped (campaigns §1 region filter trap).
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');

const matching =
  ({ status, species, region }: Filters) =>
  (builder: From) =>
    builder.and([
      ...(status === undefined ? [] : [builder('c.status', '=', status)]),
      ...(species === undefined ? [] : [builder(SPECIES_CODE, '=', species)]),
      ...(region === undefined
        ? []
        : [builder('c.region_name', 'ilike', `%${escapeLike(region)}%`)]),
    ]);

/** The S03 card's columns, species name joined through its code (data-spec §7). */
const cards = (database: Kysely<DB>) =>
  database
    .selectFrom('campaigns as c')
    .leftJoin('species as s', 's.code', SPECIES_CODE)
    .select([
      'c.address',
      'c.status',
      'c.title',
      SPECIES_CODE,
      's.english_name as species_name',
      'c.region_name',
      'c.tree_target',
      'c.commitment_units',
      'c.funding_target',
      'c.funded_amount',
      'c.funding_deadline',
      CREATED_BLOCK,
    ]);

/** campaigns §1 and §3: the catalog and the species list. */
const catalogReads = (database: Kysely<DB>) => ({
  /** Newest first by chain order; the caller asks for one row past the page to know whether another follows. */
  page: (filters: Filters, after: CursorPosition | null, take: number) => {
    const query = cards(database).where(matching(filters));

    return (
      after === null
        ? query
        : query.where((builder) =>
            builder(
              builder.refTuple(CREATED_BLOCK, 'c.address'),
              '<',
              builder.tuple(after.block, after.address),
            ),
          )
    )
      .orderBy(CREATED_BLOCK, 'desc')
      .orderBy('c.address', 'desc')
      .limit(take)
      .execute();
  },

  count: async (filters: Filters): Promise<number> =>
    (
      await database
        .selectFrom('campaigns as c')
        .select(sql<number>`count(*)::int`.as('total'))
        .where(matching(filters))
        .executeTakeFirstOrThrow()
    ).total,

  /** Seed reference data, by English name. */
  species: () =>
    database
      .selectFrom('species')
      .select(['code', 'english_name'])
      .orderBy('english_name')
      .execute(),
});

/** campaigns §2: one campaign's page and one wallet's figures on it. */
const pageReads = (database: Kysely<DB>) => ({
  byAddress: (address: string) =>
    cards(database)
      .select([
        'c.chain_id',
        'c.region_radius_m',
        'c.claim_deadline',
        'c.split',
        'c.anchor_slots',
        'c.open_slots',
        'c.per_planter_cap',
        (builder) =>
          builder
            .selectFrom('trees')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('trees.campaign_address', '=', 'c.address')
            .as('planted'),
        (builder) =>
          builder
            .selectFrom('slots')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('slots.campaign_address', '=', 'c.address')
            .where('slots.kind', '=', 'open')
            .where('slots.status', 'in', ['claimed', 'planted'])
            .as('open_taken'),
      ])
      .where('c.address', '=', address)
      .executeTakeFirst(),

  /** Money the wallet put in and got back, and the open slots it holds. */
  walletFigures: (address: string, wallet: string) =>
    database
      .selectNoFrom((builder) => [
        builder
          .selectFrom('contributions')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('n'))
          .where('campaign_address', '=', address)
          .where('contributor_address', '=', wallet)
          .as('contributed'),
        builder
          .selectFrom('refunds')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('n'))
          .where('campaign_address', '=', address)
          .where('contributor_address', '=', wallet)
          .as('refunded'),
        builder
          .selectFrom('slots')
          .select(sql<number>`count(*)::int`.as('n'))
          .where('campaign_address', '=', address)
          .where('kind', '=', 'open')
          .where('planter_address', '=', wallet)
          .as('held'),
      ])
      .executeTakeFirstOrThrow(),
});

export const campaignsRepository = (database: Kysely<DB>) => ({
  ...catalogReads(database),
  ...pageReads(database),
});

export type CampaignsRepository = ReturnType<typeof campaignsRepository>;

export type CampaignCardRow = Awaited<ReturnType<CampaignsRepository['page']>>[number];

export type CampaignRow = NonNullable<Awaited<ReturnType<CampaignsRepository['byAddress']>>>;
