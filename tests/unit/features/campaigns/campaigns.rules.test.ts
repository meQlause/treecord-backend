import { describe, expect, it } from 'vitest';
import {
  budget,
  claimRefusal,
  daysLeft,
  decodeCampaignCursor,
  encodeCampaignCursor,
  fundingDeadlinePassed,
  openAvailable,
  progressBps,
  remainingCap,
} from '../../../../src/features/campaigns/campaigns.rules.js';

const SPLIT = {
  incentivesBps: 7000,
  seedlingsBps: 1000,
  verificationBps: 500,
  reserveBps: 1000,
  feeBps: 500,
};
const CHAIN_NOW = new Date('2026-10-23T03:12:44Z');
const DEMAK_DEADLINE = new Date('2026-11-10T00:00:00Z');

// docs/BE/features/campaigns.md §1–§2 computed fields, with their worked examples.
describe('progressBps', () => {
  it.each([
    ['6840000000', '10000000000', 6840],
    ['4200000000', '8000000000', 5250],
    ['10000000000', '10000000000', 10_000],
    ['0', '10000000000', 0],
    ['9999', '10000000000', 0],
    ['0', '0', 0],
  ])('%s of %s is %i', (funded, target, expected) => {
    expect(progressBps(funded, target)).toBe(expected);
  });
});

describe('daysLeft and fundingDeadlinePassed', () => {
  it('17 d 20 h 47 m before the deadline is 18 days left', () => {
    expect(daysLeft('funding', DEMAK_DEADLINE, CHAIN_NOW)).toBe(18);
    expect(fundingDeadlinePassed('funding', DEMAK_DEADLINE, CHAIN_NOW)).toBe(false);
  });

  it('past the deadline: no days left, and passed', () => {
    const after = new Date('2026-11-10T00:00:01Z');

    expect(daysLeft('funding', DEMAK_DEADLINE, after)).toBeNull();
    expect(fundingDeadlinePassed('funding', DEMAK_DEADLINE, after)).toBe(true);
  });

  it('exactly at the deadline it has not passed (the contract uses >)', () => {
    expect(fundingDeadlinePassed('funding', DEMAK_DEADLINE, DEMAK_DEADLINE)).toBe(false);
    expect(daysLeft('funding', DEMAK_DEADLINE, DEMAK_DEADLINE)).toBe(0);
  });

  it.each(['active', 'refunding', 'completed'] as const)('a %s campaign has neither', (status) => {
    expect(daysLeft(status, DEMAK_DEADLINE, CHAIN_NOW)).toBeNull();
    expect(fundingDeadlinePassed(status, new Date('2026-01-01Z'), CHAIN_NOW)).toBe(false);
  });
});

describe('budget', () => {
  it('splits 10,000 USDC by the default split', () => {
    expect(budget('10000000000', SPLIT)).toEqual([
      { bucket: 'incentives', bps: 7000, amount: '7000000000' },
      { bucket: 'seedlings', bps: 1000, amount: '1000000000' },
      { bucket: 'verification', bps: 500, amount: '500000000' },
      { bucket: 'reserve', bps: 1000, amount: '1000000000' },
      { bucket: 'fee', bps: 500, amount: '500000000' },
    ]);
  });

  it('gives the rounding remainder to the reserve, so the buckets sum to the target (FR-078)', () => {
    expect(budget('10000000001', SPLIT).map((line) => line.amount)).toEqual([
      '7000000000',
      '1000000000',
      '500000000',
      '1000000001',
      '500000000',
    ]);
  });

  it('keeps digits beyond 2^53 (REG-001)', () => {
    const lines = budget('90071992547409930000', SPLIT);

    expect(lines[0]?.amount).toBe('63050394783186951000');
    expect(lines.reduce((sum, line) => sum + BigInt(line.amount), 0n)).toBe(90071992547409930000n);
  });
});

describe('openAvailable and remainingCap', () => {
  it('open slots less those taken and those queued; 0 after the claim deadline', () => {
    expect(openAvailable({ openSlots: 750, taken: 0, queued: 0, claimDeadlinePassed: false })).toBe(
      750,
    );
    expect(openAvailable({ openSlots: 750, taken: 1, queued: 2, claimDeadlinePassed: false })).toBe(
      747,
    );
    expect(openAvailable({ openSlots: 750, taken: 0, queued: 0, claimDeadlinePassed: true })).toBe(
      0,
    );
    expect(openAvailable({ openSlots: 2, taken: 2, queued: 1, claimDeadlinePassed: false })).toBe(
      0,
    );
  });

  it('Sari holding open slot 41 has 49 of 50 left; never below 0', () => {
    expect(remainingCap({ cap: 50, held: 1, queued: 0 })).toBe(49);
    expect(remainingCap({ cap: 50, held: 49, queued: 3 })).toBe(0);
  });
});

describe('the list cursor', () => {
  it("encodes the last row's block and address as the §1 example does", () => {
    expect(
      encodeCampaignCursor({
        block: '29104480',
        address: '0x0000000000000000000000000000000000000002',
      }),
    ).toBe(
      'eyJiIjoiMjkxMDQ0ODAiLCJhIjoiMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAyIn0',
    );
  });

  it('decodes what it encodes', () => {
    const position = { block: '29104480', address: '0x0000000000000000000000000000000000000002' };

    expect(decodeCampaignCursor(encodeCampaignCursor(position))).toEqual(position);
  });

  it.each([
    ['not base64url JSON', 'not-a-cursor'],
    ['JSON of the wrong shape', Buffer.from('{"b":1}').toString('base64url')],
    ['a block that is not an integer', Buffer.from('{"b":"1.5","a":"0x00"}').toString('base64url')],
    [
      'an address that is not one',
      Buffer.from('{"b":"1","a":"0xZZ00000000000000000000000000000000000000"}').toString(
        'base64url',
      ),
    ],
  ])('refuses %s with invalid_cursor', (_case, cursor) => {
    expect(() => decodeCampaignCursor(cursor)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });
});

describe('claimRefusal (§6): the first that applies', () => {
  const CLAIM = {
    count: 2,
    status: 'active',
    claimDeadline: new Date('2026-12-10T00:00:00Z'),
    chainNow: new Date('2026-10-23T03:12:44Z'),
    slots: { open: 750, taken: 1, queued: 0, cap: 50, held: 1, ownQueued: 0 },
  };

  it('an Active campaign inside its window with slots and cap left: no refusal', () => {
    expect(claimRefusal(CLAIM)).toBeNull();
    expect(claimRefusal({ ...CLAIM, chainNow: CLAIM.claimDeadline })).toBeNull();
  });

  it.each([
    [
      'a campaign still funding',
      { status: 'funding' },
      { code: 'campaign_not_active', details: { status: 'funding' } },
    ],
    [
      'past the claim deadline',
      { chainNow: new Date('2026-12-10T00:00:01Z') },
      { code: 'claim_window_closed', details: { claimDeadline: '2026-12-10T00:00:00.000Z' } },
    ],
    [
      'more than the open slots left',
      { count: 5, slots: { ...CLAIM.slots, open: 6, taken: 1, queued: 1 } },
      { code: 'not_enough_slots', details: { available: 4 } },
    ],
    [
      'more than the cap left',
      { count: 4, slots: { ...CLAIM.slots, cap: 50, held: 46, ownQueued: 1 } },
      { code: 'planter_cap_exceeded', details: { remaining: 3, cap: 50 } },
    ],
  ])('%s', (_case, change, refusal) => {
    expect(claimRefusal({ ...CLAIM, ...change })).toEqual(refusal);
  });

  it('a campaign that is not Active is refused first, whatever else is wrong', () => {
    expect(claimRefusal({ ...CLAIM, status: 'completed', count: 999 })?.code).toBe(
      'campaign_not_active',
    );
  });
});
