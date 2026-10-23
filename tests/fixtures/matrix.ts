import { sql } from 'kysely';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { ROLES } from '../helpers/access-matrix.js';
import {
  aCampaign,
  aPlantedTree,
  CAMPAIGN as TREE_CAMPAIGN,
  theSpecies,
  TREE_ID,
} from './mirror.js';

// The records tests/integration/container.test.ts probes: one per route the access matrix (ADR-008) calls.

export const CAMPAIGN = '0x00000000000000000000000000000000000000c1';

// an Active campaign where the matrix planter (wallet 0x2222…) holds slot 1 with its tag
export const PLANTING_CAMPAIGN = '0x00000000000000000000000000000000000000c2';

export const PLANTER_WALLET = `0x${'2'.repeat(40)}`;

export const METADATA_ID = '7d5c9b8e-1f4a-4c2e-9a3b-6f0e2d1c4b5a';

// an Active mahogany campaign, its anchor slots all unassigned, for the operator actions
export const OPS_CAMPAIGN = '0x00000000000000000000000000000000000000c3';

// an open flag on tree 3001, which every role's wallet contributed to
export const OPEN_FLAG_ID = '1f6c2a9e-4b7d-4e15-9a3c-8d2e5f0b7a61';

export const ISSUED_TX = `0x${'1'.repeat(64)}`;

// The wallet of the role at this index in ROLES: 0x1111… for the donor, and so on.
export const roleWallet = (index: number): string => `0x${String(index + 1).repeat(40)}`;

// Every role's wallet contributed to tree 3001's campaign, and the tree has an open flag.
const flaggableTree = async (database: DatabaseClient): Promise<void> => {
  for (const [index] of ROLES.entries()) {
    await sql`insert into public.contributions (campaign_address, contributor_address, amount, total_raised_after,
        block_number, block_time, log_index, tx_hash)
      values (${TREE_CAMPAIGN}, ${roleWallet(index)}, 1, 1, 1, now(), ${index}, ${ISSUED_TX})`.execute(
      database,
    );
  }

  await sql`insert into public.flags (id, tree_id, campaign_address, flagger_address, reason_text, reason_hash, status)
    values (${OPEN_FLAG_ID}, ${TREE_ID}, ${TREE_CAMPAIGN}, ${PLANTER_WALLET}, 'Matrix', ${ISSUED_TX}, 'open')`.execute(
    database,
  );
};

// One issued batch and one retirement from it, on CAMPAIGN.
const carbonRecords = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx, issued_at)
    values (1, ${CAMPAIGN}, 100, 'Verra', 'V-1', 'V-100', 2026, 1, ${ISSUED_TX}, now())`.execute(
    database,
  );
  await sql`insert into public.retirements (retirement_id, batch_id, amount, holder_address, beneficiary, purpose,
      retired_at, log_index, tx_hash)
    values (1, 1, 10, ${CAMPAIGN}, 'PT Hijau Lestari', '', now(), 0, ${ISSUED_TX})`.execute(
    database,
  );
};

// OPS_CAMPAIGN, no slot taken yet; the species must be seeded first.
const operationsCampaign = async (database: DatabaseClient): Promise<void> => {
  await aCampaign(database, {
    address: OPS_CAMPAIGN,
    status: 'active',
    species_code: 'SWIETENIA_MACROPHYLLA',
  });
};

/** Everything the matrix probes, once its profiles exist; the donor saved the campaign metadata. */
export const matrixWorld = async (
  database: DatabaseClient,
  donorProfileId: string,
): Promise<void> => {
  await aCampaign(database, { address: CAMPAIGN });
  await aPlantedTree(database);
  await aCampaign(database, { address: PLANTING_CAMPAIGN, status: 'active' });

  await flaggableTree(database);
  await theSpecies(database);
  await operationsCampaign(database);
  await sql`insert into public.campaign_metadata (id, creator_profile_id, title, species_code, region_name,
      region_center_lat, region_center_lon, region_radius_m)
    values (${METADATA_ID}, ${donorProfileId}, 'Matrix', 'PERSEA_AMERICANA', 'Matrix', 0, 0, 100)`.execute(
    database,
  );
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${PLANTING_CAMPAIGN}, 1, 'open', 'claimed', ${PLANTER_WALLET})`.execute(database);
  await sql`insert into public.slot_tags (campaign_address, slot_id, code)
    values (${PLANTING_CAMPAIGN}, 1, 'TC-MATR-2XAA')`.execute(database);
  await carbonRecords(database);
};
