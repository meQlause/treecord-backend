import { describe, expect, it } from 'vitest';
import {
  linkChecks,
  milestoneWindow,
  reasonsOf,
  targetChecks,
  type LinkFacts,
  type TargetFacts,
} from '../../../../../src/features/evidence/prechecks/prechecks.rules.js';

const epochMs = (iso: string): number => Date.parse(iso);
const SARI = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';
const UNIT = '2592000';
const OPENS = epochMs('2026-10-15T05:00:00Z');
const CLOSES = epochMs('2026-11-14T05:00:00Z');

// Tree 3001's month-6 check-in, everything in order.
const ALIVE: TargetFacts = {
  kind: 'ALIVE',
  callerWallet: SARI,
  target: { label: 'Tree #3001', planterAddress: SARI },
  campaignStatus: 'active',
  tree: {
    status: 'alive',
    replantDeadline: null,
    plantedAt: epochMs('2026-04-18T05:00:00Z'),
    pausedSeconds: '0',
    unitSeconds: UNIT,
  },
  milestone: 2,
  chainTime: epochMs('2026-10-23T03:12:44Z'),
  held: null,
  mirrored: false,
  openChallengeCode: null,
  issuedTag: 'TC-K7QM-3XRA',
};

const PLANTED: TargetFacts = {
  ...ALIVE,
  kind: 'PLANTED',
  target: { label: 'Slot #41', planterAddress: SARI },
  tree: null,
  milestone: null,
};

const reasons = (change: Partial<TargetFacts>, base: TargetFacts = ALIVE) =>
  reasonsOf(targetChecks({ ...base, ...change }));

// docs/BE/features/evidence-prechecks.md §1–§2, the "Target" column.
describe('target prechecks', () => {
  it('an ALIVE target in its window passes, with the rows ALIVE uses in FR-130 order', () => {
    const rows = targetChecks(ALIVE);

    expect(rows.map(({ check }) => check)).toEqual([
      'ownership',
      'tree_status',
      'milestone_window',
      'target_free',
      'challenge',
      'tag',
    ]);
    expect(reasonsOf(rows)).toEqual([]);
  });

  it('a PLANTED target uses campaign status instead of tree status and window, and no challenge', () => {
    expect(targetChecks(PLANTED).map(({ check }) => check)).toEqual([
      'ownership',
      'campaign_status',
      'target_free',
      'tag',
    ]);
  });

  it('the window is inclusive at both ends (Campaign._window)', () => {
    expect(milestoneWindow(ALIVE.tree?.plantedAt ?? 0, '0', UNIT, 2)).toEqual({
      opensAt: OPENS,
      closesAt: CLOSES,
    });
    expect(reasons({ chainTime: OPENS })).toEqual([]);
    expect(reasons({ chainTime: CLOSES })).toEqual([]);
    expect(reasons({ chainTime: CLOSES + 1000 })).toEqual(['milestone_not_open']);
    expect(reasons({ chainTime: OPENS - 1000 })).toEqual(['milestone_not_open']);
  });
});

describe('target prechecks: each reason', () => {
  it.each([
    [
      'someone else holds the tree',
      { target: { label: 'Tree #3001', planterAddress: '0x1' } },
      ['tree_not_owned'],
    ],
    ['a flagged tree', { tree: { ...ALIVE.tree, status: 'flagged' } }, ['wrong_tree_status']],
    [
      'a live check-in holds the month',
      { held: { id: '5c1e9a7d-3b2f', status: 'needs_review', milestone: 2 } },
      ['milestone_already_done'],
    ],
    ['a payout is already mirrored', { mirrored: true }, ['milestone_already_done']],
    ['no tag issued', { issuedTag: null }, ['tag_missing']],
    ['an open challenge never blocks', { openChallengeCode: 'R4M9' }, []],
  ])('ALIVE: %s', (_case, change, expected) => {
    expect(reasons(change as Partial<TargetFacts>)).toEqual(expected);
  });

  it.each([
    [
      'a slot someone else holds',
      { target: { label: 'Slot #41', planterAddress: '0x1' } },
      ['slot_not_owned'],
    ],
    ['a campaign not Active', { campaignStatus: 'funding' }, ['campaign_not_active']],
    ['a slot already planted', { mirrored: true }, ['slot_already_planted']],
  ])('PLANTED: %s', (_case, change, expected) => {
    expect(reasons(change as Partial<TargetFacts>, PLANTED)).toEqual(expected);
  });

  it('REPLANTED needs a Dead tree before its deadline by chain time; DEAD a live one', () => {
    const deadline = epochMs('2026-11-04T05:00:00Z');
    const dead = {
      ...ALIVE.tree,
      status: 'dead',
      replantDeadline: deadline,
    } as TargetFacts['tree'];
    const replant = { ...ALIVE, kind: 'REPLANTED' as const, tree: dead, milestone: null };

    expect(reasons({}, replant)).toEqual([]);
    expect(reasons({ chainTime: deadline }, replant)).toEqual([]);
    expect(reasons({ chainTime: deadline + 1000 }, replant)).toEqual(['replant_deadline_passed']);
    expect(reasons({ tree: ALIVE.tree }, replant)).toEqual(['wrong_tree_status']);
    expect(reasons({ tree: dead }, { ...ALIVE, kind: 'DEAD', milestone: null })).toEqual([
      'wrong_tree_status',
    ]);
  });

  it('reports every failing reason in FR-130 order', () => {
    expect(
      reasons({
        target: { label: 'Tree #3001', planterAddress: '0x1' },
        chainTime: CLOSES + 1000,
        mirrored: true,
        issuedTag: null,
      }),
    ).toEqual(['tree_not_owned', 'milestone_not_open', 'milestone_already_done', 'tag_missing']);
  });
});

const LINK: LinkFacts = {
  ...ALIVE,
  callerProfileId: 'sari',
  durationSec: 7.2,
  existingByHash: null,
};

const linkReasons = (change: Partial<LinkFacts>) => reasonsOf(linkChecks({ ...LINK, ...change }));

// docs/BE/features/evidence-prechecks.md §1 "Link": unique_video, duration, then the target checks; no challenge row.
describe('link prechecks', () => {
  it('uses unique_video and duration before the target checks, and drops the challenge row', () => {
    expect(linkChecks({ ...LINK, openChallengeCode: 'R4M9' }).map(({ check }) => check)).toEqual([
      'unique_video',
      'duration',
      'ownership',
      'tree_status',
      'milestone_window',
      'target_free',
      'tag',
    ]);
  });

  it.each([
    [3.9, ['video_too_short']],
    [4, []],
    [12, []],
    [12.1, ['video_too_long']],
  ])('a %s s video: %j', (seconds, expected) => {
    expect(linkReasons({ durationSec: seconds })).toEqual(expected);
  });

  it('an unknown duration is not checked, never passed', () => {
    const [, checked] = linkChecks({ ...LINK, durationSec: null });

    expect(checked).toEqual({
      check: 'duration',
      ok: null,
      value: 'unknown',
      limit: '4–12 s',
      reason: null,
    });
  });

  it.each([
    [
      'the caller re-sending the same queued upload',
      { profileId: 'sari', status: 'queued', sameTarget: true },
      [],
    ],
    [
      'the caller, for another target',
      { profileId: 'sari', status: 'queued', sameTarget: false },
      ['duplicate_video'],
    ],
    [
      'a rejected video, never accepted again',
      { profileId: 'sari', status: 'rejected', sameTarget: true },
      ['duplicate_video'],
    ],
    [
      'someone else',
      { profileId: 'dewi', status: 'queued', sameTarget: true },
      ['duplicate_video'],
    ],
  ])('a hash already held by %s', (_case, holder, expected) => {
    expect(linkReasons({ existingByHash: holder })).toEqual(expected);
  });
});
