import { sql } from 'kysely';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { aCampaign, aProfile, theSpecies } from './mirror.js';

// The mockup's "Roots that stay" (trees.md §1): Sari's Alive tree 3001 with two paid milestones, her Flagged tree 3091,
// her tree 3104 whose month-6 check-in is in review, and Alex, who gave it 1,200 USDC.
export const ROOTS = '0x0000000000000000000000000000000000000003';

export const SARI = 'did:privy:cm2sari0000000000000000';

export const SARI_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';

export const ALEX = 'did:privy:cm2alex0000000000000000';

export const RAKA = 'did:privy:cm2raka0000000000000000';

export const PLANTED_TX = '0x701b0abfeea3fecb2a3c5eeca4be4db1ddf9c6a34a3a995d5259f210ed21397f';

export const CHECK_IN_TX = '0xfc1aa44341c8f43ddcb5395ad09f71054cb5e8c40396b51a98ae4a454b215eed';

export const PLANTED_EVIDENCE =
  '0x70e975f0bb53d200bfa7a1d9aa946ac692f54c6f60a59d4c08377fd9b5010ba8';

export const CHECK_IN_EVIDENCE =
  '0x2903d8f5241e15d014d926e0f87116581e691ed91f9d3236d5de7ed3b09e513e';

export const PLANTED_KEYFRAME = '5e3a8c1d-2b4f-4d6e-9a7c-1f0b3e5d7c92/0.jpg';

export const IN_REVIEW_ID = '9c2b7e4a-3d1f-4a8e-b6c5-0f9e8d7a6b53';

export const OPEN_FLAG_ID = '1f6c2a9e-4b7d-4e15-9a3c-8d2e5f0b7a61';

const ALEX_WALLET = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';
const PLANTED_AT = '2026-04-18T05:00:00Z';
const CHECK_IN_AT = '2026-07-20T05:00:00Z';

const aTree = async (
  database: DatabaseClient,
  treeId: number,
  slotId: number,
  status: string,
): Promise<void> => {
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${ROOTS}, ${slotId}, 'open', 'planted', ${SARI_WALLET})`.execute(database);
  await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx, exact_lat, exact_lon, status)
    values (${treeId}, ${ROOTS}, ${slotId}, ${SARI_WALLET}, ${PLANTED_AT}, 'qqtttzp', ${CHECK_IN_EVIDENCE},
      ${PLANTED_TX}, -7.431205, 109.247813, ${status}::public.tree_status)`.execute(database);
};

// each tree's payouts sit at their own log index in the shared transactions (unique tx hash and log index)
const paidTwice = async (
  database: DatabaseClient,
  treeId: number,
  logIndex: number,
): Promise<void> => {
  await sql`insert into public.milestone_payouts (tree_id, campaign_address, milestone, amount, planter_address,
      block_number, block_time, log_index, tx_hash)
    values (${treeId}, ${ROOTS}, 0, 1050000, ${SARI_WALLET}, 24118402, ${PLANTED_AT}, ${logIndex}, ${PLANTED_TX}),
           (${treeId}, ${ROOTS}, 1, 1050000, ${SARI_WALLET}, 28136002, ${CHECK_IN_AT}, ${logIndex}, ${CHECK_IN_TX})`.execute(
    database,
  );
};

/** Tree 3001's chain events and the two submissions behind them. */
const tree3001History = async (database: DatabaseClient, sari: string): Promise<void> => {
  await sql`insert into public.tree_events (tree_id, kind, block_number, block_time, log_index, tx_hash, evidence_hash)
    values (3001, 'planted', 24118402, ${PLANTED_AT}, 0, ${PLANTED_TX}, ${PLANTED_EVIDENCE}),
           (3001, 'check_in', 28136002, ${CHECK_IN_AT}, 0, ${CHECK_IN_TX}, ${CHECK_IN_EVIDENCE})`.execute(
    database,
  );
  await sql`insert into public.submissions (profile_id, campaign_address, kind, milestone, slot_id, tree_id,
      video_sha256, evidence_hash, policy_score, keyframe_paths, status)
    values (${sari}, ${ROOTS}, 'PLANTED', 0, 1, null, ${'a'.repeat(64)}, ${PLANTED_EVIDENCE}, 9580,
              ${[PLANTED_KEYFRAME]}, 'onchain'),
           (${sari}, ${ROOTS}, 'ALIVE', 1, null, 3001, ${'b'.repeat(64)}, ${CHECK_IN_EVIDENCE}, 9230,
              ${['a71d4e0b-6c3f-4b8a-8e2d-5f9c0b1a3d47/0.jpg']}, 'onchain')`.execute(database);
  await paidTwice(database, 3001, 1);
  await sql`insert into public.slot_tags (campaign_address, slot_id, code) values (${ROOTS}, 1, 'TC-K7QM-3XRA')`.execute(
    database,
  );
};

/** Tree 3091, flagged at month 6, and tree 3104 with its month-6 check-in in review. */
const otherTrees = async (database: DatabaseClient, sari: string): Promise<void> => {
  await aTree(database, 3091, 2, 'flagged');
  await paidTwice(database, 3091, 2);
  await sql`insert into public.flags (id, tree_id, campaign_address, flagger_address, reason_text, reason_hash,
      status, opened_at, opened_tx)
    values (${OPEN_FLAG_ID}, 3091, ${ROOTS}, ${ALEX_WALLET}, 'Tree condition needs an independent check.',
      '0xc29baac38459527c791a529ef47d1cc43d3734cef04e63520492971274b411cb', 'open', '2026-10-20T09:14:27Z',
      '0x1ce442d81b6082fbb178e08bddf5191b38417d30caae1a738e505a3a3303314c')`.execute(database);
  await aTree(database, 3104, 3, 'alive');
  await sql`insert into public.submissions (id, profile_id, campaign_address, kind, milestone, tree_id,
      video_sha256, status)
    values (${IN_REVIEW_ID}, ${sari}, ${ROOTS}, 'ALIVE', 2, 3104, ${'c'.repeat(64)}, 'needs_review')`.execute(
    database,
  );
};

export const rootsThatStay = async (database: DatabaseClient): Promise<void> => {
  await theSpecies(database);
  await aCampaign(database, {
    address: ROOTS,
    status: 'active',
    title: 'Roots that stay',
    species_code: 'SWIETENIA_MACROPHYLLA',
    region_name: 'Banyumas, Central Java',
    per_tree_incentive: '10500000',
  });

  const sari = await aProfile(database, 'planter', SARI, SARI_WALLET);

  await aProfile(database, 'donor', ALEX, ALEX_WALLET);
  await aProfile(database, 'operator', RAKA);
  await sql`insert into public.contributions (campaign_address, contributor_address, amount, total_raised_after,
      block_number, block_time, log_index, tx_hash)
    values (${ROOTS}, ${ALEX_WALLET}, 1200000000, 1200000000, 20000000, now(), 0, ${PLANTED_TX})`.execute(
    database,
  );
  await aTree(database, 3001, 1, 'alive');
  await tree3001History(database, sari);
  await otherTrees(database, sari);
};
