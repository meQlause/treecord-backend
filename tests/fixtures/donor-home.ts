import { sql } from 'kysely';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { aCampaign, aProfile, theSpecies } from './mirror.js';

// donor.md's Alex: 250 USDC to "A new tide for Demak" (Funding, nothing planted), 1,200 to "Roots that stay" (984
// trees, 2,100 USDC paid out) and 900 to "Back to the mangroves" (900 trees, 6,125 USDC paid out, 25 refunded), with
// two open flags on Roots, his own pending one, and his carbon. Bulk rows come from generate_series.
export const DEMAK = '0x0000000000000000000000000000000000000001';

export const ROOTS = '0x0000000000000000000000000000000000000003';

export const MANGROVES = '0x0000000000000000000000000000000000000006';

export const ALEX = 'did:privy:cm2alex0000000000000000';

export const ALEX_WALLET = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';

export const PENDING_FLAG = '3b9e4c1a-6d9f-4a37-9c5e-af4a7b2d9c83';

export const OPEN_FLAG_3092 = '2a8d3b0f-5c8e-4f26-8b4d-9e3f6a1c8b72';

export const OPEN_FLAG_3091 = '1f6c2a9e-4b7d-4e15-9a3c-8d2e5f0b7a61';

const PLANTER = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';
const OTHER_DONOR = 'did:privy:cm2dewi0000000000000000';
const HASH = (seed: string) => sql`'0x' || md5(${seed} || i) || md5(${seed} || i || 'x')`;
const hashOf = (digit: string) => `0x${digit.repeat(64)}`;

const campaigns = async (database: DatabaseClient): Promise<void> => {
  await theSpecies(database);
  await aCampaign(database, {
    address: DEMAK,
    title: 'A new tide for Demak',
    species_code: 'RHIZOPHORA_MUCRONATA',
    region_name: 'Demak, Central Java',
    funded_amount: '6840000000',
    created_block: '30',
  });
  await aCampaign(database, {
    address: ROOTS,
    status: 'active',
    title: 'Roots that stay',
    species_code: 'SWIETENIA_MACROPHYLLA',
    region_name: 'Banyumas, Central Java',
    tree_target: 1200,
    anchor_slots: 300,
    open_slots: 900,
    funding_target: '18000000000',
    funded_amount: '18000000000',
    incentive_pool: '12600000000',
    estimated_amount: '8005',
    created_block: '20',
  });
  await aCampaign(database, {
    address: MANGROVES,
    status: 'completed',
    title: 'Back to the mangroves',
    species_code: 'RHIZOPHORA_MUCRONATA',
    region_name: 'Cilacap, Central Java',
    tree_target: 900,
    anchor_slots: 225,
    open_slots: 675,
    funding_target: '9000000000',
    funded_amount: '9000000000',
    incentive_pool: '6300000000',
    estimated_amount: '20000',
    created_block: '10',
  });
};

/** `count` trees from `firstTreeId`, each status taking the next `n` of them. */
const treesOf = async (
  database: DatabaseClient,
  campaign: string,
  firstTreeId: number,
  statuses: [string, number][],
): Promise<void> => {
  let offset = 0;

  for (const [status, count] of statuses) {
    await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
      select ${campaign}, ${offset} + i, 'open', 'planted', ${PLANTER} from generate_series(1, ${count}) as i`.execute(
      database,
    );
    await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
        latest_evidence_hash, planted_tx, status)
      select ${firstTreeId - 1 + offset} + i, ${campaign}, ${offset} + i, ${PLANTER}, '2026-04-18T05:00:00Z',
        'qqtttzp', ${HASH(`e${campaign}`)}, ${HASH(`t${campaign}`)}, ${status}::public.tree_status
      from generate_series(1, ${count}) as i`.execute(database);
    offset += count;
  }
};

/** `count` payouts of `amount` on consecutive trees from `firstTreeId`. */
const payouts = async (
  database: DatabaseClient,
  campaign: string,
  {
    milestone,
    firstTreeId,
    count,
    amount,
  }: { milestone: number; firstTreeId: number; count: number; amount: number },
): Promise<void> => {
  await sql`insert into public.milestone_payouts (tree_id, campaign_address, milestone, amount, planter_address,
      block_number, block_time, log_index, tx_hash)
    select ${firstTreeId - 1} + i, ${campaign}, ${milestone}, ${amount}, ${PLANTER}, i, '2026-07-20T05:00:00Z',
      ${milestone}, ${HASH(`p${campaign}${milestone}`)}
    from generate_series(1, ${count}) as i`.execute(database);
};

const trees = async (database: DatabaseClient): Promise<void> => {
  await treesOf(database, ROOTS, 3001, [
    ['alive', 948],
    ['flagged', 2],
    ['dead', 20],
    ['removed', 14],
  ]);
  await treesOf(database, MANGROVES, 5001, [
    ['completed', 875],
    ['dead', 10],
    ['removed', 15],
  ]);
  await payouts(database, ROOTS, { milestone: 0, firstTreeId: 3001, count: 984, amount: 1050000 });
  await payouts(database, ROOTS, { milestone: 1, firstTreeId: 3001, count: 984, amount: 1050000 });
  await payouts(database, ROOTS, { milestone: 2, firstTreeId: 3002, count: 32, amount: 1050000 });
  await payouts(database, MANGROVES, {
    milestone: 0,
    firstTreeId: 5001,
    count: 875,
    amount: 7000000,
  });
};

const money = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.contributions (campaign_address, contributor_address, amount, total_raised_after,
      block_number, block_time, log_index, tx_hash)
    values (${DEMAK}, ${ALEX_WALLET}, 250000000, 250000000, 1, now(), 0, ${hashOf('1')}),
           (${ROOTS}, ${ALEX_WALLET}, 1200000000, 1200000000, 2, now(), 0, ${hashOf('2')}),
           (${MANGROVES}, ${ALEX_WALLET}, 900000000, 900000000, 3, now(), 0, ${hashOf('3')})`.execute(
    database,
  );
  await sql`insert into public.refunds (campaign_address, contributor_address, amount, block_number, block_time,
      log_index, tx_hash)
    values (${MANGROVES}, ${ALEX_WALLET}, 25000000, 4, now(), 0, ${hashOf('4')})`.execute(database);
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx, issued_at)
    values (101, ${MANGROVES}, 16000, 'SRN PPI', 'SRN-2025-00001', 'SRN-2025-16000', 2025, 2, ${hashOf('5')}, now()),
           (103, ${MANGROVES}, 6000, 'SRN PPI', 'SRN-2024-00001', 'SRN-2024-06000', 2024, 1, ${hashOf('6')}, now())`.execute(
    database,
  );
  await sql`insert into public.carbon_balances (batch_id, holder_address, amount, updated_block)
    values (101, ${ALEX_WALLET}, 1200, 3)`.execute(database);
  await sql`insert into public.carbon_reservations (campaign_address, holder_address, reserved_amount, allocated_amount)
    values (${MANGROVES}, ${ALEX_WALLET}, 2000, 1600), (${ROOTS}, ${ALEX_WALLET}, 533, 0)`.execute(
    database,
  );
};

const flags = async (database: DatabaseClient, alex: string, other: string): Promise<void> => {
  await sql`insert into public.flags (id, tree_id, campaign_address, flagger_address, flagger_profile_id,
      reason_text, reason_hash, status, created_at, opened_at, opened_tx)
    values (${OPEN_FLAG_3091}, 3091, ${ROOTS}, ${ALEX_WALLET}, null, 'Tree condition needs an independent check.',
              ${hashOf('7')}, 'open', '2026-10-20T09:13:58.771Z', '2026-10-20T09:14:27Z', ${hashOf('a')}),
           (${OPEN_FLAG_3092}, 3092, ${ROOTS}, ${ALEX_WALLET}, null, 'Recent evidence needs review.', ${hashOf('8')},
              'open', '2026-10-20T10:02:51.004Z', '2026-10-20T10:03:39Z', ${hashOf('b')}),
           (${PENDING_FLAG}, 3103, ${ROOTS}, ${ALEX_WALLET}, ${alex},
              'Reason saved; wallet transaction has not been confirmed.', ${hashOf('9')}, 'pending',
              '2026-10-22T08:41:09.330Z', null, null),
           (gen_random_uuid(), 3104, ${ROOTS}, ${ALEX_WALLET}, ${other}, 'Someone else''s unsent draft.',
              ${hashOf('c')}, 'pending', '2026-10-22T09:00:00Z', null, null)`.execute(database);
};

export const donorHome = async (database: DatabaseClient): Promise<void> => {
  await campaigns(database);
  await trees(database);
  await money(database);

  const alex = await aProfile(database, 'donor', ALEX, ALEX_WALLET);
  const other = await aProfile(database, 'donor', OTHER_DONOR, `0x${'d'.repeat(40)}`);

  await flags(database, alex, other);
};
