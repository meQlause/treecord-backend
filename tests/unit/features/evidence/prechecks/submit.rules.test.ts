import { describe, expect, it } from 'vitest';
import { reasonsOf } from '../../../../../src/features/evidence/prechecks/prechecks.rules.js';
import {
  submitChecks,
  type SubmitFacts,
} from '../../../../../src/features/evidence/prechecks/submit.rules.js';

const epochMs = (iso: string): number => Date.parse(iso);
const SARI = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';
const NOW = epochMs('2026-10-23T09:16:00Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;
const TREE = { lat: -7.42431, lon: 109.23987 };
// the frozen haversine's radius: a point due north lies R × Δlat away
const EARTH_RADIUS_M = 6_371_008.8;
const north = (meters: number) => ({
  lat: TREE.lat + ((meters / EARTH_RADIUS_M) * 180) / Math.PI,
  lon: TREE.lon,
});

// Sari's month-6 check-in on tree 3001, signed on her phone, everything in order.
const CHECK_IN: SubmitFacts = {
  kind: 'ALIVE',
  callerWallet: SARI,
  callerProfileId: 'sari',
  target: { label: 'Tree #3001', planterAddress: SARI },
  campaignStatus: 'active',
  tree: {
    status: 'alive',
    replantDeadline: null,
    plantedAt: epochMs('2026-04-18T05:00:00Z'),
    pausedSeconds: '0',
    unitSeconds: '2592000',
  },
  milestone: 2,
  chainTime: epochMs('2026-10-23T09:12:31Z'),
  held: null,
  mirrored: false,
  openChallengeCode: null,
  issuedTag: 'TC-K7QM-3XRA',
  device: { profileId: 'sari', revoked: false },
  canonicalMatches: true,
  verified: true,
  storedSha256: 'a'.repeat(64),
  payload: {
    deviceKey: 'x3Jd9kQpT2aBvR7mN4cY8wLs1eFhGz6uK0oPiXjVbQs',
    videoSha256: 'a'.repeat(64),
    ...north(2.9),
    acc: 8.4,
    capturedAt: NOW - HOUR,
    challenge: null,
    tag: 'TC-K7QM-3XRA',
  },
  now: NOW,
  reference: TREE,
  radiusM: 15,
  durationSec: 6,
};

const reasons = (change: Partial<SubmitFacts>, base: SubmitFacts = CHECK_IN) =>
  reasonsOf(submitChecks({ ...base, ...change }));

const withPayload = (change: Partial<SubmitFacts['payload']>) =>
  reasons({ payload: { ...CHECK_IN.payload, ...change } });

// docs/BE/features/evidence-prechecks.md §1 "Submit", §2.
describe('submit prechecks', () => {
  it('a sound check-in passes every row, in FR-130 order, and its rows read as S21 prints them', () => {
    const rows = submitChecks(CHECK_IN);

    expect(rows.map(({ check }) => check)).toEqual([
      'device',
      'signature',
      'video_hash',
      'unique_video',
      'capture_time',
      'gps_accuracy',
      'location',
      'duration',
      'ownership',
      'tree_status',
      'milestone_window',
      'target_free',
      'challenge',
      'tag',
    ]);
    expect(reasonsOf(rows)).toEqual([]);
    expect(rows[5]).toEqual({
      check: 'gps_accuracy',
      ok: true,
      value: '8.4 m',
      limit: '≤ 300 m',
      reason: null,
    });
    expect(rows[6]).toMatchObject({ value: '2.9 m away', limit: '≤ 15 m from the planting' });
  });

  it.each([
    [
      'no device with this key',
      { device: null, canonicalMatches: true },
      ['device_unknown_or_revoked'],
    ],
    [
      'a revoked device',
      { device: { profileId: 'sari', revoked: true } },
      ['device_unknown_or_revoked'],
    ],
    [
      "another account's device",
      { device: { profileId: 'dewi', revoked: false } },
      ['device_not_owned'],
    ],
    ['a payload changed after signing', { canonicalMatches: false }, ['signature_invalid']],
    ['a signature that does not verify', { verified: false }, ['signature_invalid']],
    [
      'an unknown device and a changed payload',
      { device: null, canonicalMatches: false },
      ['device_unknown_or_revoked', 'signature_invalid'],
    ],
    ['stored bytes that differ', { storedSha256: 'b'.repeat(64) }, ['hash_mismatch']],
  ])('%s', (_case, change, expected) => {
    expect(reasons(change as Partial<SubmitFacts>)).toEqual(expected);
  });
});

describe('submit prechecks: time, GPS and place', () => {
  it('an unknown device leaves the signature not checked, never passed', () => {
    expect(submitChecks({ ...CHECK_IN, device: null })[1]).toMatchObject({
      check: 'signature',
      ok: null,
    });
  });

  it('capture time: 72 h old and 5 min ahead both pass; a millisecond more fails (FR-133)', () => {
    expect(withPayload({ capturedAt: NOW - 72 * HOUR })).toEqual([]);
    expect(withPayload({ capturedAt: NOW - 72 * HOUR - 1 })).toEqual(['stale_capture']);
    expect(withPayload({ capturedAt: NOW + 5 * MINUTE })).toEqual([]);
    expect(withPayload({ capturedAt: NOW + 5 * MINUTE + 1 })).toEqual(['future_capture']);
  });

  it('GPS accuracy: 300.0 m passes, 300.1 m fails (FR-134)', () => {
    expect(withPayload({ acc: 300 })).toEqual([]);
    expect(withPayload({ acc: 300.1 })).toEqual(['gps_inaccurate']);
  });

  it('a check-in within 15 m of the planting passes; beyond, or with no planting location, it moved', () => {
    expect(withPayload(north(14.99))).toEqual([]);
    expect(withPayload(north(15.01))).toEqual(['moved_tree']);
    expect(submitChecks({ ...CHECK_IN, reference: null })[6]).toMatchObject({
      value: 'no planting location',
      reason: 'moved_tree',
    });
  });
});

const PLANTING: SubmitFacts = {
  ...CHECK_IN,
  kind: 'PLANTED',
  target: { label: 'Slot #41', planterAddress: SARI },
  tree: null,
  milestone: null,
  issuedTag: 'TC-B2YK-5ZWN',
  payload: { ...CHECK_IN.payload, tag: 'TC-B2YK-5ZWN' },
  radiusM: 2500,
};

const plantingAt = (meters: number) => ({ payload: { ...PLANTING.payload, ...north(meters) } });

describe('submit prechecks for a planting', () => {
  it('within the campaign radius passes; beyond it, or with no region centre, is outside the region', () => {
    expect(reasons(plantingAt(2499.9), PLANTING)).toEqual([]);
    expect(reasons(plantingAt(2500.1), PLANTING)).toEqual(['outside_region']);
    expect(submitChecks({ ...PLANTING, ...plantingAt(312) })[6]).toMatchObject({
      value: '312 m from center',
      limit: '≤ 2,500 m from center',
    });
    expect(submitChecks({ ...PLANTING, reference: null })[6]).toMatchObject({
      value: 'no region center',
      reason: 'outside_region',
    });
  });

  it('the FR-130 acceptance pair keeps its order: GPS accuracy, then region', () => {
    expect(
      reasons({ payload: { ...PLANTING.payload, ...north(3000), acc: 341 } }, PLANTING),
    ).toEqual(['gps_inaccurate', 'outside_region']);
  });

  it('a planting has no challenge row', () => {
    expect(submitChecks(PLANTING).map(({ check }) => check)).not.toContain('challenge');
  });
});

describe('submit prechecks: challenge and tag', () => {
  it('an open challenge must be carried; none open passes (FR-139)', () => {
    expect(
      reasons({ openChallengeCode: 'R4M9', payload: { ...CHECK_IN.payload, challenge: 'R4M9' } }),
    ).toEqual([]);
    expect(reasons({ openChallengeCode: 'R4M9' })).toEqual(['challenge_missing']);
    expect(submitChecks({ ...CHECK_IN, openChallengeCode: 'R4M9' })[12]).toMatchObject({
      value: 'none',
      limit: 'carries R4M9',
    });
  });

  it('a tag must be issued and carried (FR-140); a payload without one mismatches', () => {
    expect(reasons({ issuedTag: null })).toEqual(['tag_missing']);
    expect(withPayload({ tag: 'TC-AAAA-BBBB' })).toEqual(['tag_mismatch']);

    const untagged = Object.fromEntries(
      Object.entries(CHECK_IN.payload).filter(([key]) => key !== 'tag'),
    ) as SubmitFacts['payload'];

    expect(reasons({ payload: untagged })).toEqual(['tag_mismatch']);
  });
});
