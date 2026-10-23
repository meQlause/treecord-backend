import { sql } from 'kysely';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { aCampaign, aProfile, theSpecies } from './mirror.js';

// planter.md's Sari on "Roots that stay": eight trees (3001–3004 and 3104 Alive, 3091 and 3092 Flagged, 3100 Dead),
// claimed slot 41 and anchor slot 42 not planted yet, challenges R4M9 on 3001 and T2X8 on 3104 (whose month-6
// check-in is in review), and three uploads.
export const ROOTS = '0x0000000000000000000000000000000000000003';

export const SARI = 'did:privy:cm2sari0000000000000000';

export const SARI_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';

export const DEVICE_ID = 'c2a9f4e1-6b3d-4a7f-9e08-1d5b7c3a2f96';

export const IN_REVIEW = '5c1e9a7d-3b2f-4e80-9d6a-0f7b2c4e8a13';

export const REJECTED = 'a4d7e2c9-81b3-4f6e-b05a-3c9d1e7f2a64';

export const PLANTING = 'e3f8b1a6-27c4-4d9e-8a50-6b1f0c3d9e72';

export const CHALLENGE_3001 = '8f3b2d1e-7a6c-4e95-b0d4-2c1a9e8f7b63';

export const CHALLENGE_3104 = '1d7e4c2a-9b5f-4a83-8e60-3f2b1c9d7a45';

const AUDITOR = 'did:privy:cm2auditor000000000000';
const PLANTED_AT = '2026-04-18T05:00:00Z';
const hashOf = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;

// [tree, slot, status, tag, paid milestones]
const TREES: [number, number, string, string, number[]][] = [
  [3001, 1, 'alive', 'TC-K7QM-3XRA', [0, 1]],
  [3002, 2, 'alive', 'TC-A2B3-C4D5', [0, 1, 2]],
  [3003, 3, 'alive', 'TC-A2B3-C4D6', [0, 1, 2]],
  [3004, 4, 'alive', 'TC-A2B3-C4D7', [0, 1, 2]],
  [3104, 5, 'alive', 'TC-M3XV-7GPD', [0, 1]],
  [3091, 6, 'flagged', 'TC-A2B3-C4D8', [0, 1]],
  [3092, 7, 'flagged', 'TC-A2B3-C4D9', [0, 1]],
  [3100, 8, 'dead', 'TC-A2B3-C4DA', [0]],
];

const trees = async (database: DatabaseClient): Promise<void> => {
  for (const [treeId, slotId, status, tag, paid] of TREES) {
    await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
      values (${ROOTS}, ${slotId}, 'open', 'planted', ${SARI_WALLET})`.execute(database);
    await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
        latest_evidence_hash, planted_tx, status)
      values (${treeId}, ${ROOTS}, ${slotId}, ${SARI_WALLET}, ${PLANTED_AT}, 'qqtttzp', ${hashOf('e')},
        ${hashOf('f')}, ${status}::public.tree_status)`.execute(database);
    await sql`update public.slots set tree_id = ${treeId} where campaign_address = ${ROOTS} and slot_id = ${slotId}`.execute(
      database,
    );
    await sql`insert into public.slot_tags (campaign_address, slot_id, code) values (${ROOTS}, ${slotId}, ${tag})`.execute(
      database,
    );

    const payoutTx = `0x${String(treeId).repeat(16)}`;

    for (const milestone of paid) {
      await sql`insert into public.milestone_payouts (tree_id, campaign_address, milestone, amount, planter_address,
          block_number, block_time, log_index, tx_hash)
        values (${treeId}, ${ROOTS}, ${milestone}, 1050000, ${SARI_WALLET}, 1, ${PLANTED_AT}, ${milestone},
          ${payoutTx})`.execute(database);
    }
  }
};

const unplantedSlots = async (database: DatabaseClient): Promise<void> => {
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address, claimed_at)
    values (${ROOTS}, 41, 'open', 'claimed', ${SARI_WALLET}, '2026-10-20T02:11:09Z'),
           (${ROOTS}, 42, 'anchor', 'anchor', ${SARI_WALLET}, '2026-10-20T02:11:09Z')`.execute(
    database,
  );
  await sql`insert into public.slot_tags (campaign_address, slot_id, code, issued_at)
    values (${ROOTS}, 41, 'TC-B2YK-5ZWN', '2026-10-20T02:14:52.318Z'),
           (${ROOTS}, 42, 'TC-R7DH-8QEX', '2026-10-20T02:14:52.318Z')`.execute(database);
};

const uploads = async (database: DatabaseClient, sari: string): Promise<void> => {
  await sql`insert into public.devices (id, profile_id, public_key_jwk, thumbprint, label)
    values (${DEVICE_ID}, ${sari}, '{"kty":"EC","crv":"P-256","x":"jJS05mv-cR1HdUP28swlbXQIYKI8ehjhET7Nx8kM5v4","y":"2CLcMpUlQAq2Vq5ISJwemZZaUibvScWZBMbiNPm9qxA"}',
      'x3Jd9kQpT2aBvR7mN4cY8wLs1eFhGz6uK0oPiXjVbQs', 'Pixel 8')`.execute(database);
  await sql`insert into public.submissions (id, profile_id, campaign_address, kind, milestone, slot_id, tree_id,
      video_sha256, status, captured_at, duration_sec, payload, device_id, received_at, precheck_results)
    values (${IN_REVIEW}, ${sari}, ${ROOTS}, 'ALIVE', 2, null, 3104, ${'1'.repeat(64)}, 'needs_review',
              '2026-10-18T07:05:00Z', 7, '{"acc":8.4}', ${DEVICE_ID}, '2026-10-18T07:10:00Z', null),
           (${REJECTED}, ${sari}, ${ROOTS}, 'ALIVE', 2, null, 3001, ${'2'.repeat(64)}, 'rejected',
              '2026-10-17T06:40:00Z', 6, '{"acc":41.0}', ${DEVICE_ID}, '2026-10-17T06:45:00Z',
              '[{"check":"gps_accuracy","ok":false,"value":"41.0 m","limit":"≤ 30 m","reason":"gps_inaccurate"}]'),
           (${PLANTING}, ${sari}, ${ROOTS}, 'PLANTED', 0, 1, null, ${'3'.repeat(64)}, 'onchain',
              '2026-04-18T05:12:00Z', 8, '{"acc":6.2}', ${DEVICE_ID}, '2026-04-18T05:20:00Z', null),
           (gen_random_uuid(), ${sari}, ${ROOTS}, 'ALIVE', 2, null, 3002, ${'4'.repeat(64)}, 'queued',
              null, null, null, null, '2026-10-19T00:00:00Z', null)`.execute(database);
};

const challenges = async (database: DatabaseClient): Promise<void> => {
  const auditor = await aProfile(database, 'auditor', AUDITOR);

  await sql`insert into public.challenges (id, tree_id, code, issued_by_profile_id, created_at, expires_at)
    values (${CHALLENGE_3001}, 3001, 'R4M9', ${auditor}, '2026-10-21T04:00:00Z', '2026-12-20T04:00:00Z'),
           (${CHALLENGE_3104}, 3104, 'T2X8', ${auditor}, '2026-10-21T04:00:00Z', '2026-12-20T04:00:00Z')`.execute(
    database,
  );
};

export const planterWorkspace = async (database: DatabaseClient): Promise<void> => {
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
    per_tree_incentive: '10500000',
  });

  const sari = await aProfile(database, 'planter', SARI, SARI_WALLET);

  await trees(database);
  await unplantedSlots(database);
  await uploads(database, sari);
  await challenges(database);
};
