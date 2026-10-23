import { describe, expect, it } from 'vitest';
import {
  buildReport,
  challengeRefusal,
  missingFindings,
  totalsOf,
  type SampleFacts,
} from '../../../../src/features/audit/audit.rules.js';

// docs/BE/features/audit.md §7 and §10: the closed demo session `868c029f-…`, sample [3091, 3001].
const SAMPLES: SampleFacts[] = [
  {
    position: 0,
    treeId: '3091',
    finding: 'needs_followup',
    notes: 'Flag remains open.',
    recordedAt: '2026-10-21T05:40:00.000Z',
  },
  {
    position: 1,
    treeId: '3001',
    finding: 'ok',
    notes: 'Planting and month-3 evidence consistent.',
    recordedAt: '2026-10-21T05:20:00.000Z',
  },
];

const DEMO_CLOSED = {
  session: {
    id: '868c029f-2a97-4721-b005-f66b88e3768b',
    campaign: '0x0000000000000000000000000000000000000003',
    blockNumber: '17000001',
    blockHash: '0xd0e38899a3d5c3657e22f95fdada4f0da6aa36ea51545d334455da8663d50701',
    seed: '0x791f45521e15b6066b8e598549c8dd5f59d9283ffe919c1cb3418767d3534c49',
    population: ['3001', '3020', '3021', '3091', '3092', '3103', '3104'],
    sampleSize: 2,
  },
  auditor: {
    profileId: '5f0c2a9e-8d41-4b7a-9c3e-1a6d2f8b4e70',
    wallet: '0x2a7f3c9e1b5d8f0a4c6e2b9d7f1a3c5e8b0d2f4a',
  },
  samples: SAMPLES,
  challenges: [],
  closedAt: '2026-10-21T06:00:00.000Z',
  // the mockup's fixed demo salt; a real close draws 32 fresh bytes
  salt: `0x${'5a'.repeat(32)}`,
  summary:
    'Sample reviewed; one tree needs follow-up while its flag is resolved. No registry certification is implied.',
};

describe('buildReport (FR-191, FR-192)', () => {
  it('the §7 demo report hashes to 0x97eb…5341 and seals its notes as 0x60b1…d545', () => {
    const { report, notes, reportHash } = buildReport(DEMO_CLOSED);

    expect(reportHash).toBe('0x97eb3c933091e9f179119cb8a4396c7301c1ccc911fa4573ccce6ffd1d2c5341');
    expect(report.notesHash).toBe(
      '0x60b1ce72a79120a3d943e93d68c5cfbaa7e5b98b99114469896c74f4da14d545',
    );
    expect(report.totals).toEqual({ ok: 1, issue: 0, needsFollowup: 1 });
    expect(JSON.stringify(report)).not.toContain('Flag remains open.');
    expect(notes.findings).toEqual([
      { position: 0, notes: 'Flag remains open.' },
      { position: 1, notes: 'Planting and month-3 evidence consistent.' },
    ]);
  });

  it('a fresh salt seals the same notes to another hash (FR-191 acceptance 5)', () => {
    const resalted = buildReport({ ...DEMO_CLOSED, salt: `0x${'5b'.repeat(32)}` });

    expect(resalted.report.notesHash).not.toBe(buildReport(DEMO_CLOSED).report.notesHash);
  });
});

describe('missingFindings and totalsOf (FR-190)', () => {
  it('names the trees still without a finding, in position order, and counts each finding', () => {
    const open = [
      { ...SAMPLES[0], finding: null } as SampleFacts,
      { ...SAMPLES[1], finding: 'issue' } as SampleFacts,
      { position: 2, treeId: '3104', finding: null, notes: null, recordedAt: null },
    ];

    expect(missingFindings(open)).toEqual(['3091', '3104']);
    expect(missingFindings(SAMPLES)).toEqual([]);
    expect(totalsOf(open)).toEqual({ ok: 0, issue: 1, needsFollowup: 0 });
  });
});

// §6, FR-198 (REG-007 keeps the order itself).
describe('challengeRefusal', () => {
  const SAMPLED_ALIVE = {
    sessionStatus: 'open',
    sampled: true,
    openChallenge: null,
    treeStatus: 'alive',
  };
  const OPEN = {
    id: '4c1f8e2a-7b3d-4e9a-8f6c-2d5e1a9b7c30',
    expiresAt: '2026-12-20T04:00:00.000Z',
  };

  it('lets a sampled Alive tree with no open challenge through', () => {
    expect(challengeRefusal(SAMPLED_ALIVE)).toBeNull();
  });

  it.each([
    [{ sessionStatus: 'closed' }, { code: 'session_closed' }],
    [{ sampled: false }, { code: 'not_found' }],
    [
      { openChallenge: OPEN },
      { code: 'challenge_active', details: { challengeId: OPEN.id, expiresAt: OPEN.expiresAt } },
    ],
    [{ treeStatus: 'dead' }, { code: 'tree_not_alive', details: { status: 'dead' } }],
  ])('%o answers %o', (change, refusal) => {
    expect(challengeRefusal({ ...SAMPLED_ALIVE, ...change })).toEqual(refusal);
  });
});
