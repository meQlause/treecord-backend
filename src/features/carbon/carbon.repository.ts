import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';
import type { BatchPosition } from './carbon.rules.js';

// carbon.md §1–§5: reads of the carbon mirror. Every amount, price and id is text (REG-001).

const BATCH_ID = 'b.batch_id';
const CAMPAIGNS = 'campaigns as c';
const CAMPAIGN_ADDRESS = 'c.address';
const BATCH_CAMPAIGN = 'b.campaign_address';
const SPECIES = 'species as s';
const SPECIES_KEY = 's.code';
const SPECIES_CODE = 'c.species_code';
const TITLE = 'c.title';
const REGION = 'c.region_name';
const SPECIES_NAME = 's.english_name as species_name';
const REGISTRY = 'b.registry';
const VINTAGE = 'b.vintage';
const SERIAL_START = 'b.serial_start';
const SERIAL_END = 'b.serial_end';
const BATCHES = 'carbon_batches as b';
const HOLDER = 'holder_address';
const RETIREMENT_HOLDER = 'r.holder_address';
const RETIREMENT_ID = 'r.retirement_id';
const ISSUED_BLOCK = 'b.issued_block';

/** A batch as S07, S08 and D08 show it; inventory is what the ledger itself still holds (FR-213). */
const batches = (database: Kysely<DB>, ledger: string) =>
  database
    .selectFrom(BATCHES)
    .innerJoin(CAMPAIGNS, CAMPAIGN_ADDRESS, BATCH_CAMPAIGN)
    .leftJoin(SPECIES, SPECIES_KEY, SPECIES_CODE)
    .select([
      sql<string>`b.batch_id::text`.as('batch_id'),
      REGISTRY,
      VINTAGE,
      SERIAL_START,
      SERIAL_END,
      'b.amount',
      'b.price_usdc_per_tonne',
      'b.issued_at',
      sql<string>`b.issued_block::text`.as('issued_block'),
      'b.issued_tx',
      'c.address as campaign_address',
      TITLE,
      REGION,
      SPECIES_CODE,
      SPECIES_NAME,
      (builder) =>
        builder
          .selectFrom('carbon_balances as held')
          .select(sql<string>`held.amount::text`.as('amount'))
          .whereRef('held.batch_id', '=', BATCH_ID)
          .where('held.holder_address', '=', ledger)
          .as('inventory'),
    ]);

const catalogReads = (database: Kysely<DB>, ledger: string) => ({
  /** §1: newest issuance first; one row past the page tells whether another follows. */
  batchPage: (campaign: string | undefined, after: BatchPosition | null, take: number) => {
    const query = batches(database, ledger).$if(campaign !== undefined, (filtered) =>
      filtered.where(BATCH_CAMPAIGN, '=', campaign ?? ''),
    );

    return (
      after === null
        ? query
        : query.where((builder) =>
            builder(
              builder.refTuple(ISSUED_BLOCK, BATCH_ID),
              '<',
              builder.tuple(after.block, after.batchId),
            ),
          )
    )
      .orderBy(ISSUED_BLOCK, 'desc')
      .orderBy(BATCH_ID, 'desc')
      .limit(take)
      .execute();
  },

  batchCount: async (campaign: string | undefined): Promise<number> =>
    (
      await database
        .selectFrom('carbon_batches')
        .select(sql<number>`count(*)::int`.as('total'))
        .$if(campaign !== undefined, (filtered) =>
          filtered.where('campaign_address', '=', campaign ?? ''),
        )
        .executeTakeFirstOrThrow()
    ).total,

  batch: (batchId: string) =>
    batches(database, ledger).where(BATCH_ID, '=', batchId).executeTakeFirst(),

  /** data-spec §5.2.3: set once from the block; two readers write the same value. */
  fillIssuedAt: async (batchId: string, issuedAt: Date): Promise<void> => {
    await database
      .updateTable('carbon_batches')
      .set({ issued_at: issuedAt })
      .where('batch_id', '=', batchId)
      .where('issued_at', 'is', null)
      .execute();
  },
});

const retirements = (database: Kysely<DB>) =>
  database
    .selectFrom('retirements as r')
    .innerJoin(BATCHES, BATCH_ID, 'r.batch_id')
    .select([
      sql<string>`r.retirement_id::text`.as('retirement_id'),
      sql<string>`r.batch_id::text`.as('batch_id'),
      REGISTRY,
      'r.amount',
      'r.beneficiary',
      'r.purpose',
      'r.retired_at',
      RETIREMENT_HOLDER,
      'r.tx_hash',
      'r.registry_retirement_status',
      'r.registry_reference',
    ]);

/** §3: one wallet's totals and reservations. */
export const holdingReads = (database: Kysely<DB>) => ({
  summary: (wallet: string) =>
    database
      .selectNoFrom((builder) => [
        builder
          .selectFrom('carbon_balances')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('n'))
          .where(HOLDER, '=', wallet)
          .as('issued'),
        builder
          .selectFrom('carbon_reservations')
          .select(sql<string>`coalesce(sum(allocated_amount), 0)::text`.as('n'))
          .where(HOLDER, '=', wallet)
          .as('allocated'),
        builder
          .selectFrom('carbon_reservations')
          .select(sql<string>`coalesce(sum(reserved_amount - allocated_amount), 0)::text`.as('n'))
          .where(HOLDER, '=', wallet)
          .as('unfilled'),
        builder
          .selectFrom('retirements')
          .select(sql<string>`coalesce(sum(amount), 0)::text`.as('n'))
          .where(HOLDER, '=', wallet)
          .as('retired'),
      ])
      .executeTakeFirstOrThrow(),

  reservations: (wallet: string) =>
    database
      .selectFrom('carbon_reservations as r')
      .innerJoin(CAMPAIGNS, CAMPAIGN_ADDRESS, 'r.campaign_address')
      .leftJoin(SPECIES, SPECIES_KEY, SPECIES_CODE)
      .select([
        CAMPAIGN_ADDRESS,
        TITLE,
        REGION,
        SPECIES_CODE,
        SPECIES_NAME,
        'r.reserved_amount',
        'r.allocated_amount',
        sql<string>`(r.reserved_amount - r.allocated_amount)::text`.as('unfilled_amount'),
        'r.declined',
        'r.updated_at',
      ])
      .where(RETIREMENT_HOLDER, '=', wallet)
      .orderBy('r.updated_at', 'desc')
      .orderBy(CAMPAIGN_ADDRESS, 'desc')
      .execute(),
});

/** §3–§4: the batches a wallet holds and what it retired. */
const walletBatchReads = (database: Kysely<DB>) => ({
  /** FR-229: batches the wallet still holds, with what it retired from each. */
  balances: (wallet: string) =>
    database
      .selectFrom('carbon_balances as held')
      .innerJoin(BATCHES, BATCH_ID, 'held.batch_id')
      .innerJoin(CAMPAIGNS, CAMPAIGN_ADDRESS, BATCH_CAMPAIGN)
      .select([
        sql<string>`b.batch_id::text`.as('batch_id'),
        CAMPAIGN_ADDRESS,
        TITLE,
        REGION,
        REGISTRY,
        VINTAGE,
        SERIAL_START,
        SERIAL_END,
        'held.amount',
        (builder) =>
          builder
            .selectFrom('retirements as r')
            .select(sql<string>`coalesce(sum(r.amount), 0)::text`.as('n'))
            .whereRef('r.batch_id', '=', BATCH_ID)
            .where(RETIREMENT_HOLDER, '=', wallet)
            .as('retired_amount'),
      ])
      .where('held.holder_address', '=', wallet)
      .where('held.amount', '>', '0')
      .orderBy(BATCH_ID, 'desc')
      .execute(),

  retirementPage: (wallet: string, after: string | null, take: number) =>
    retirements(database)
      .where(RETIREMENT_HOLDER, '=', wallet)
      .$if(after !== null, (query) => query.where(RETIREMENT_ID, '<', after ?? ''))
      .orderBy(RETIREMENT_ID, 'desc')
      .limit(take)
      .execute(),

  retirementCount: async (wallet: string): Promise<number> =>
    (
      await database
        .selectFrom('retirements')
        .select(sql<number>`count(*)::int`.as('total'))
        .where(HOLDER, '=', wallet)
        .executeTakeFirstOrThrow()
    ).total,
});

/** §5: the public certificate, with its batch and campaign. */
const certificateReads = (database: Kysely<DB>) => ({
  certificate: (retirementId: string) =>
    retirements(database)
      .innerJoin(CAMPAIGNS, CAMPAIGN_ADDRESS, BATCH_CAMPAIGN)
      .leftJoin(SPECIES, SPECIES_KEY, SPECIES_CODE)
      .select([
        VINTAGE,
        SERIAL_START,
        SERIAL_END,
        'b.amount as issued_amount',
        'b.issued_tx',
        'c.address as campaign_address',
        TITLE,
        REGION,
        'c.region_geohash',
        SPECIES_CODE,
        SPECIES_NAME,
        'c.tree_target',
      ])
      .where(RETIREMENT_ID, '=', retirementId)
      .executeTakeFirst(),
});

const REGISTRY_COLUMNS = [
  'retirement_id',
  'registry_retirement_status',
  'registry_reference',
  'updated_at',
] as const;

/** §6: the registry status, the one retirement column the API writes (ADR-015). */
const registryWrites = (database: Kysely<DB>) => ({
  /** pending → done, once; undefined when the row is absent or already done. */
  markRegistryRetired: (retirementId: string, reference: string | null) =>
    database
      .updateTable('retirements')
      .set({
        registry_retirement_status: 'done',
        registry_reference: reference,
        updated_at: sql`now()`,
      })
      .where('retirement_id', '=', retirementId)
      .where('registry_retirement_status', '=', 'pending')
      .returning(REGISTRY_COLUMNS)
      .executeTakeFirst(),

  registryRetirement: (retirementId: string) =>
    database
      .selectFrom('retirements')
      .select(REGISTRY_COLUMNS)
      .where('retirement_id', '=', retirementId)
      .executeTakeFirst(),
});

export const carbonRepository = (database: Kysely<DB>, ledger: string) => ({
  ...catalogReads(database, ledger),
  ...registryWrites(database),
  ...holdingReads(database),
  ...walletBatchReads(database),
  ...certificateReads(database),
});

export type CarbonRepository = ReturnType<typeof carbonRepository>;

type Rows<Read extends keyof CarbonRepository> = Awaited<ReturnType<CarbonRepository[Read]>>;

export type BatchRow = Rows<'batchPage'>[number];

export type RetirementRow = Rows<'retirementPage'>[number];

export type HoldingRows = {
  summary: Rows<'summary'>;
  reservations: Rows<'reservations'>;
  balances: Rows<'balances'>;
};

export type RegistryRow = NonNullable<Rows<'registryRetirement'>>;

export type CertificateRow = NonNullable<Rows<'certificate'>>;
