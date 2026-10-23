import { sql } from 'kysely';
import { getDeployment } from '../../src/generated/frozen/addresses.js';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { aCampaign, aProfile, theSpecies } from './mirror.js';

// carbon.md §1–§5's market: five batches (102 newest, then 101; 103 sold out, 104 paused, 105 unpriced), Alex's
// reservations, balance and retirement, and certificate No. 1 held by another wallet.
export const FOREST = '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc';

export const MANGROVES = '0x0000000000000000000000000000000000000006';

export const ROOTS = '0x0000000000000000000000000000000000000003';

export const ALEX = 'did:privy:cm2alex0000000000000000';

export const ALEX_WALLET = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';

export const SARI = 'did:privy:cm2sari0000000000000000';

export const NO_WALLET = 'did:privy:cm2nowallet00000000000';

export const BATCH_101_TX = '0x1b8e3f5a7c9d0e2b4f6a8c1d3e5b7f9a0c2d4e6b8f1a3c5e7d9b0f2a4c6e8d1b';

export const BATCH_102_TX = '0x4e7a1c9d3b5f2e8a0c6d4b2f9e1a7c3d5b8f0e2a4c6d9b1f3e5a7c0d2b4f6e8a';

export const RETIREMENT_1_TX = '0x2d5f8b1e4a7c0d3f6b9e2a5c8f1d4b7e0a3c6f9d2b5e8a1c4f7d0b3e6a9c2f5d';

export const RETIREMENT_2_TX = '0x7c2e9a4f1b3d5e8c0a6f2d4b9e1c3a5f7d0b2e4c6a8f1d3b5e7c9a0f2d4b6e8c';

export const CERTIFICATE_HOLDER = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9f0e';

// the ledger holds the unsold inventory (FR-213)
const LEDGER = getDeployment(31337).carbonLedger.toLowerCase();
const OTHER_TX = (digit: string) => `0x${digit.repeat(64)}`;

const campaigns = async (database: DatabaseClient): Promise<void> => {
  await theSpecies(database);
  await aCampaign(database, {
    address: FOREST,
    title: 'A forest, together',
    region_name: 'Magelang, Central Java',
    species_code: 'SWIETENIA_MACROPHYLLA',
  });
  await aCampaign(database, {
    address: MANGROVES,
    status: 'completed',
    title: 'Back to the mangroves',
    region_name: 'Cilacap, Central Java',
    region_geohash: 'qqguwvt',
    species_code: 'RHIZOPHORA_MUCRONATA',
    tree_target: 900,
    anchor_slots: 225,
    open_slots: 675,
  });
  await aCampaign(database, {
    address: ROOTS,
    status: 'active',
    title: 'Roots that stay',
    region_name: 'Banyumas, Central Java',
    species_code: 'SWIETENIA_MACROPHYLLA',
  });
};

const batches = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx, issued_at, price_usdc_per_tonne)
    values (102, ${FOREST}, 24000, 'Verra', 'VCS-2025-00001', 'VCS-2025-24000', 2025, 481300, ${BATCH_102_TX},
              '2026-09-18T08:00:00Z', 22000000),
           (101, ${MANGROVES}, 16000, 'SRN PPI', 'SRN-2025-00001', 'SRN-2025-16000', 2025, 481203,
              ${BATCH_101_TX}, '2026-09-12T08:00:00Z', 18500000),
           (103, ${MANGROVES}, 6000, 'SRN PPI', 'SRN-2024-00001', 'SRN-2024-06000', 2024, 481100, ${OTHER_TX('3')},
              '2026-09-01T08:00:00Z', 17000000),
           (104, ${ROOTS}, 1000, 'Verra', 'VCS-2026-00001', 'VCS-2026-01000', 2026, 481000, ${OTHER_TX('4')},
              null, 0),
           (105, ${ROOTS}, 1000, 'Verra', 'VCS-2026-01001', 'VCS-2026-02000', 2026, 480900, ${OTHER_TX('5')},
              '2026-08-20T08:00:00Z', null)`.execute(database);
  await sql`insert into public.carbon_balances (batch_id, holder_address, amount, updated_block)
    values (102, ${LEDGER}, 12500, 481300), (101, ${LEDGER}, 8400, 481203), (103, ${LEDGER}, 0, 481100),
           (104, ${LEDGER}, 1000, 481000), (105, ${LEDGER}, 1000, 480900),
           (101, ${ALEX_WALLET}, 1200, 481400)`.execute(database);
};

const holdings = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.carbon_reservations (campaign_address, holder_address, reserved_amount,
      allocated_amount, updated_at)
    values (${MANGROVES}, ${ALEX_WALLET}, 2000, 1600, '2026-09-18T08:00:00Z'),
           (${ROOTS}, ${ALEX_WALLET}, 533, 0, '2026-09-18T08:00:00Z')`.execute(database);
  await sql`insert into public.retirements (retirement_id, batch_id, amount, holder_address, beneficiary, purpose,
      retired_at, log_index, tx_hash)
    values (1, 101, 500, ${CERTIFICATE_HOLDER}, 'PT Hijau Lestari', '2026 scope 3 offset', '2026-09-20T08:00:00Z',
              0, ${RETIREMENT_1_TX}),
           (2, 101, 400, ${ALEX_WALLET}, 'PT Hijau Lestari', '2026 scope 3 offset', '2026-09-20T08:00:00Z', 0,
              ${RETIREMENT_2_TX})`.execute(database);
};

export const carbonMarket = async (database: DatabaseClient): Promise<void> => {
  await campaigns(database);
  await batches(database);
  await holdings(database);
  await aProfile(database, 'donor', ALEX, ALEX_WALLET);
  await aProfile(database, 'planter', SARI, '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e');
  await aProfile(database, 'donor', NO_WALLET);
};
