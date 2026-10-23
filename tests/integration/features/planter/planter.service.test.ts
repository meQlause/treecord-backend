import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueSlotTags } from '../../../../src/features/planter/index.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { aCampaign } from '../../../fixtures/mirror.js';

const CAMPAIGN = `0x${'5'.repeat(40)}`;
const PLANTER = `0x${'a'.repeat(40)}`;
// bytes that map onto TC-K9AA-6B9A every time: the second slot must collide and draw again
const FIXED = Uint8Array.from([9, 30, 0, 31, 27, 32, 61, 62]);

let test: TestDatabase;

beforeAll(async () => {
  test = await startMigratedDatabase();
  await aCampaign(test.database, { address: CAMPAIGN, status: 'active' });
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${CAMPAIGN}, 1, 'open', 'claimed', ${PLANTER}), (${CAMPAIGN}, 2, 'open', 'claimed', ${PLANTER}),
           (${CAMPAIGN}, 3, 'open', 'claimed', ${PLANTER})`.execute(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/planter.md §5: the tag service B5b's capture target uses through planter/index.ts.
describe('issueSlotTags', () => {
  it('issues a missing tag once and returns the stored one afterwards', async () => {
    let calls = 0;
    const randomBytes = () => {
      calls += 1;

      return FIXED;
    };

    const first = await issueSlotTags(test.database, randomBytes, [
      { campaign: CAMPAIGN, slotId: 1 },
    ]);
    const again = await issueSlotTags(test.database, randomBytes, [
      { campaign: CAMPAIGN, slotId: 1 },
    ]);

    expect(first.get(`${CAMPAIGN}:1`)?.code).toBe('TC-K9AA-6B9A');
    expect(again.get(`${CAMPAIGN}:1`)?.code).toBe('TC-K9AA-6B9A');
    expect(calls).toBe(1);
  });

  it('draws a fresh code when one collides with another slot, at most three times', async () => {
    const sequence = [FIXED, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])];
    const tags = await issueSlotTags(test.database, () => sequence.shift() ?? FIXED, [
      { campaign: CAMPAIGN, slotId: 2 },
    ]);

    expect(tags.get(`${CAMPAIGN}:2`)?.code).toBe('TC-BCDE-FGHJ');
    await expect(
      issueSlotTags(test.database, () => FIXED, [{ campaign: CAMPAIGN, slotId: 3 }]),
    ).rejects.toMatchObject({ constraint: 'slot_tags_code_key' });
  });
});
