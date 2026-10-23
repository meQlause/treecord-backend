import { sql, type Insertable } from 'kysely';
import type { Campaigns, RelayerJobs, UserRole } from '../../src/generated/db.js';
import type { DatabaseClient } from '../../src/shared/db/database.js';

// Builders for the rows the chain mirror and the API own, written through real SQL. Values follow the mockup's demo
// data (tree #3001, a planter and an auditor) where they matter, and are minimal where they do not.
const hex = (digit: string, length: number): string => `0x${digit.repeat(length)}`;

export const PLANTER_ID = '00000000-0000-0000-0000-000000000001';

export const AUDITOR_ID = '00000000-0000-0000-0000-000000000002';

export const CAMPAIGN = hex('c', 40);

export const TREE_ID = 3001;

const PLANTER_WALLET = hex('a', 40);
const AUDITOR_WALLET = hex('b', 40);
const AGREEMENT_HASH = hex('1', 64);
const CREATED_TX = hex('2', 64);
const EVIDENCE_HASH = hex('3', 64);
const PLANTED_TX = hex('4', 64);
// the mockup's split, as the factory event carries it
const SPLIT = {
  incentivesBps: 7000,
  seedlingsBps: 1000,
  verificationBps: 500,
  reserveBps: 1000,
  feeBps: 500,
};

/** A planter, an auditor, one campaign with one claimed slot, and tree #3001 planted in it. */
export const aPlantedTree = async (database: DatabaseClient): Promise<void> => {
  await sql`
    insert into public.profiles (id, privy_user_id, wallet_address, role, carbon_rights_agreement_hash)
    values (${PLANTER_ID}, 'did:privy:planter', ${PLANTER_WALLET}, 'planter', ${AGREEMENT_HASH}),
           (${AUDITOR_ID}, 'did:privy:auditor', ${AUDITOR_WALLET}, 'auditor', null)`.execute(
    database,
  );
  await sql`
    insert into public.campaigns (address, chain_id, creator_address, region_radius_m, region_geohash, tree_target,
      anchor_slots, open_slots, per_planter_cap, funding_target, funding_deadline, claim_deadline, commitment_units,
      time_unit_seconds, split, metadata_uri, created_block, created_tx)
    values (${CAMPAIGN}, 31337, ${PLANTER_WALLET}, 2500, 'qqguw7p', 1, 0, 1, 50, 1000, now(), now(), 36, 2592000,
      ${JSON.stringify(SPLIT)}::jsonb, 'ipfs://treecord-demo', 1, ${CREATED_TX})`.execute(database);
  await sql`
    insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${CAMPAIGN}, 1, 'open', 'claimed', ${PLANTER_WALLET})`.execute(database);
  await sql`
    insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx)
    values (${TREE_ID}, ${CAMPAIGN}, 1, ${PLANTER_WALLET}, now(), 'qqguw7p', ${EVIDENCE_HASH}, ${PLANTED_TX})`.execute(
    database,
  );
};

/** A profile whose Privy user (the token subject) signs in as `role`, with an embedded wallet when given; a planter
 *  has accepted the agreement. */
export const aProfile = async (
  database: DatabaseClient,
  role: UserRole,
  privyUserId: string,
  walletAddress: string | null = null,
): Promise<string> =>
  (
    await database
      .insertInto('profiles')
      .values({
        privy_user_id: privyUserId,
        wallet_address: walletAddress,
        role,
        carbon_rights_agreement_hash: role === 'planter' ? AGREEMENT_HASH : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

/** A pending claim of two slots on CAMPAIGN, created by `createdBy`, unless `values` says otherwise. */
export const aJob = async (
  database: DatabaseClient,
  createdBy: string | null,
  values: Partial<Insertable<RelayerJobs>> = {},
): Promise<string> =>
  (
    await database
      .insertInto('relayer_jobs')
      .values({
        kind: 'claim',
        payload: { campaign: CAMPAIGN, planter: PLANTER_WALLET, count: 2 },
        created_by_profile_id: createdBy,
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

/** The five seeded species (data-spec §10), as S03 and S14 list them. */
export const theSpecies = async (database: DatabaseClient): Promise<void> => {
  await database
    .insertInto('species')
    .values(
      [
        ['PERSEA_AMERICANA', 'Persea americana', 'Alpukat', 'Avocado'],
        ['DURIO_ZIBETHINUS', 'Durio zibethinus', 'Durian', 'Durian'],
        ['SWIETENIA_MACROPHYLLA', 'Swietenia macrophylla', 'Mahoni', 'Mahogany'],
        ['RHIZOPHORA_MUCRONATA', 'Rhizophora mucronata', 'Bakau', 'Rhizophora mangrove'],
        ['FALCATARIA_FALCATA', 'Falcataria falcata', 'Sengon', 'Sengon'],
      ].map(([code = '', scientific = '', local = '', english = '']) => ({
        code,
        scientific_name: scientific,
        local_name: local,
        english_name: english,
        est_kg_co2_per_year_mature: '22.00',
        years_to_maturity: 10,
      })),
    )
    .execute();
};

/** A Funding campaign of 1,000 trees and 10,000 USDC with the default split, unless `values` says otherwise. */
export const aCampaign = async (
  database: DatabaseClient,
  values: Partial<Insertable<Campaigns>> & Pick<Insertable<Campaigns>, 'address'>,
): Promise<void> => {
  await database
    .insertInto('campaigns')
    .values({
      chain_id: 31337,
      creator_address: PLANTER_WALLET,
      region_radius_m: 2500,
      region_geohash: 'qqguw7p',
      tree_target: 1000,
      anchor_slots: 250,
      open_slots: 750,
      per_planter_cap: 50,
      funding_target: '10000000000',
      funding_deadline: new Date('2026-11-10T00:00:00.000Z'),
      claim_deadline: new Date('2026-12-10T00:00:00.000Z'),
      commitment_units: 36,
      time_unit_seconds: '2592000',
      split: SPLIT,
      metadata_uri: 'ipfs://treecord-demo',
      created_block: '1',
      created_tx: CREATED_TX,
      ...values,
    })
    .execute();
};
