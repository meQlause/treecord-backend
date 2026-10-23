import { sql } from 'kysely';
import type { DatabaseClient } from '../../src/shared/db/database.js';
import { aCampaign, aProfile } from './mirror.js';
import { PLANTED_TX, ROOTS, rootsThatStay, SARI_WALLET } from './roots-that-stay.js';

// audit.md §1–§3: "Roots that stay" grown to the mockup's audit population, 3001, 3020, 3021, 3091, 3092, 3103 and
// 3104, plus tree 3105, Removed, which no population may contain (REG-006). Nadia audits; Omar is another auditor.

export const NADIA = 'did:privy:cm2nadia000000000000000';

export const OMAR = 'did:privy:cm2omar0000000000000000';

/** An Active campaign with nothing planted (`no_trees`). */
export const BARE = '0x0000000000000000000000000000000000000007';

export const POPULATION = ['3001', '3020', '3021', '3091', '3092', '3103', '3104'];

const EXTRA = [
  { treeId: 3020, slotId: 4, status: 'alive' },
  { treeId: 3021, slotId: 5, status: 'alive' },
  { treeId: 3092, slotId: 6, status: 'alive' },
  { treeId: 3103, slotId: 7, status: 'dead' },
  { treeId: 3105, slotId: 8, status: 'removed' },
];

export const auditDemo = async (database: DatabaseClient): Promise<void> => {
  await rootsThatStay(database);

  for (const { treeId, slotId, status } of EXTRA) {
    await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
      values (${ROOTS}, ${slotId}, 'open', 'planted', ${SARI_WALLET})`.execute(database);
    await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
        latest_evidence_hash, planted_tx, status)
      values (${treeId}, ${ROOTS}, ${slotId}, ${SARI_WALLET}, '2026-04-18T05:00:00Z', 'qqtttzp', ${PLANTED_TX},
        ${PLANTED_TX}, ${status}::public.tree_status)`.execute(database);
  }

  await aCampaign(database, { address: BARE, status: 'active' });
  await aProfile(database, 'auditor', NADIA);
  await aProfile(database, 'auditor', OMAR);
};
