import { sql } from 'kysely';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { aCampaign, aProfile, theSpecies } from './mirror.js';

// reports.md §1's snapshot of "Roots that stay": 984 of 1,200 trees (948 alive, 2 flagged, 20 dead, 14 removed), 120
// contributors of 150 USDC, 984 + 984 + 32 payouts of 1.05 USDC, 68 USDC forfeited, and three evidence events. Plus
// "Back to the mangroves" with two registry batches and 400 units retired. Bulk rows come from generate_series.
export const ROOTS = '0x0000000000000000000000000000000000000003';

export const MANGROVES = '0x0000000000000000000000000000000000000004';

export const EMPTY_CAMPAIGN = '0x0000000000000000000000000000000000000005';

const SARI_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';
const DIED_TX = `0x${'d'.repeat(64)}`;
const RETIRED_TX = `0x${'e'.repeat(64)}`;

export const EVENTS = [
  {
    treeId: 3001,
    kind: 'planted',
    evidenceKind: 'PLANTED',
    milestone: 0,
    at: '2026-04-18T05:00:00.000Z',
    block: 24118402,
    logIndex: 3,
    evidenceHash: '0x70e975f0bb53d200bfa7a1d9aa946ac692f54c6f60a59d4c08377fd9b5010ba8',
    txHash: '0x701b0abfeea3fecb2a3c5eeca4be4db1ddf9c6a34a3a995d5259f210ed21397f',
  },
  {
    treeId: 3002,
    kind: 'check_in',
    evidenceKind: 'ALIVE',
    milestone: 1,
    at: '2026-07-20T05:00:00.000Z',
    block: 28136002,
    logIndex: 0,
    evidenceHash: '0x2903d8f5241e15d014d926e0f87116581e691ed91f9d3236d5de7ed3b09e513e',
    txHash: '0xfc1aa44341c8f43ddcb5395ad09f71054cb5e8c40396b51a98ae4a454b215eed',
  },
  {
    treeId: 3003,
    kind: 'check_in',
    evidenceKind: 'ALIVE',
    milestone: 2,
    at: '2026-10-18T05:00:00.000Z',
    block: 32024002,
    logIndex: 0,
    evidenceHash: '0xed13c09c23e60389c349d99219df3f7ad9dbed132a97c372c1a6b70a63bf19ad',
    txHash: '0x7f7a42c33188c857a93e22dabf6681b1d1d4ebe5235f700ee202241b4ee3ba3d',
  },
] as const;

// a distinct 32-byte hex per (seed, row), for columns that are unique or must look like hashes
const HASH = (seed: string) => sql`'0x' || md5(${seed} || i) || md5(${seed} || i || 'x')`;

const plantedTrees = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    select ${ROOTS}, i, 'open', 'planted', ${SARI_WALLET} from generate_series(1, 984) as i`.execute(
    database,
  );
  await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx, status)
    select 3000 + i, ${ROOTS}, i, ${SARI_WALLET}, '2026-04-18T05:00:00Z', 'qqtttzp', ${HASH('e')}, ${HASH('t')},
      (case when i <= 948 then 'alive' when i <= 950 then 'flagged' when i <= 970 then 'dead' else 'removed' end)
        ::public.tree_status
    from generate_series(1, 984) as i`.execute(database);
};

const money = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.contributions (campaign_address, contributor_address, amount, total_raised_after,
      block_number, block_time, log_index, tx_hash)
    select ${ROOTS}, '0x' || lpad(to_hex(i), 40, '0'), 150000000, 150000000::numeric * i, i, '2026-03-01T00:00:00Z', 0,
      ${HASH('c')}
    from generate_series(1, 120) as i`.execute(database);

  for (const [milestone, trees] of [
    [0, 984],
    [1, 984],
    [2, 32],
  ] as const) {
    // tree 3001 is still Open at month 6, so the month-6 payouts start at 3002
    await sql`insert into public.milestone_payouts (tree_id, campaign_address, milestone, amount, planter_address,
        block_number, block_time, log_index, tx_hash)
      select 3000 + i + ${milestone === 2 ? 1 : 0}, ${ROOTS}, ${milestone}, 1050000, ${SARI_WALLET}, i,
        '2026-07-20T05:00:00Z', ${milestone}, ${HASH(`p${milestone}`)}
      from generate_series(1, ${trees}) as i`.execute(database);
  }

  await sql`insert into public.milestone_forfeits (tree_id, campaign_address, milestone, amount, block_number,
      block_time, log_index, tx_hash)
    select 3000 + i, ${ROOTS}, 2, 2000000, i, '2026-10-16T05:00:00Z', 0, ${HASH('f')}
    from generate_series(951, 984) as i`.execute(database);
};

const evidence = async (database: DatabaseClient, sari: string): Promise<void> => {
  for (const [index, event] of EVENTS.entries()) {
    await sql`insert into public.tree_events (tree_id, kind, block_number, block_time, log_index, tx_hash,
        evidence_hash)
      values (${event.treeId}, ${event.kind}::public.tree_event_kind, ${event.block}, ${event.at},
        ${event.logIndex}, ${event.txHash}, ${event.evidenceHash})`.execute(database);
    await sql`insert into public.submissions (profile_id, campaign_address, kind, milestone, slot_id, tree_id,
        video_sha256, evidence_hash, status)
      values (${sari}, ${ROOTS}, ${event.evidenceKind}::public.evidence_kind, ${event.milestone},
        ${event.milestone === 0 ? 1 : null}, ${event.milestone === 0 ? null : event.treeId},
        ${String(index).repeat(64)}, ${event.evidenceHash}, 'onchain')`.execute(database);
  }

  // an event without an evidence hash is not part of the record
  await sql`insert into public.tree_events (tree_id, kind, block_number, block_time, log_index, tx_hash)
    values (3951, 'died', 32024100, '2026-10-19T05:00:00Z', 0, ${DIED_TX})`.execute(database);
};

const mangroves = async (database: DatabaseClient): Promise<void> => {
  await aCampaign(database, {
    address: MANGROVES,
    status: 'completed',
    title: 'Back to the mangroves',
    estimated_amount: '20000',
  });
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx)
    values (103, ${MANGROVES}, 6000, 'SRN PPI', 'SRN-2024-00001', 'SRN-2024-06000', 2024, 100,
              '0x3ba98bd5818a98e741d44cf260e44db09cf49f483df10f737982a67a0abeb208'),
           (101, ${MANGROVES}, 16000, 'SRN PPI', 'SRN-2025-00001', 'SRN-2025-16000', 2025, 200,
              '0xf1295876f501f93023aaf30204d5604394b4c7b7dd59fc4e451dafcd3dfe67a0')`.execute(
    database,
  );
  await sql`insert into public.retirements (retirement_id, batch_id, amount, holder_address, beneficiary, purpose,
      retired_at, log_index, tx_hash)
    values (1, 101, 400, ${SARI_WALLET}, 'PT Hijau', 'Scope 3 offset', '2026-09-01T00:00:00Z', 0,
      ${RETIRED_TX})`.execute(database);
};

export const impactReport = async (database: DatabaseClient): Promise<void> => {
  await theSpecies(database);
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
    per_tree_incentive: '10500000',
    estimated_amount: '8005',
  });
  await aCampaign(database, { address: EMPTY_CAMPAIGN, title: 'Seedlings soon' });

  const sari = await aProfile(
    database,
    'planter',
    'did:privy:cm2sari0000000000000000',
    SARI_WALLET,
  );

  await plantedTrees(database);
  await money(database);
  await evidence(database, sari);
  await mangroves(database);
};
