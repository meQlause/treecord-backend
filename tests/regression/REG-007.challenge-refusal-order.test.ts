import { expect, it } from 'vitest';
import { challengeRefusal } from '../../src/features/audit/audit.rules.js';

// REG-007 (docs/BE/testing.md §4): challenge refusals were checked in the wrong order. The refusal is the first that
// applies, in the backend order SRS §3.5.9 issue #6 follows: closed session, tree outside the sample, an open
// challenge on the tree, a tree that is not Alive.
const OPEN = { id: '4c1f8e2a-7b3d-4e9a-8f6c-2d5e1a9b7c30', expiresAt: '2026-12-20T04:00:00.000Z' };

it.each([
  [
    'a Dead, unsampled tree in a closed session',
    { sessionStatus: 'closed', sampled: false, openChallenge: OPEN, treeStatus: 'dead' },
    'session_closed',
  ],
  [
    'an unsampled tree with an open challenge',
    { sessionStatus: 'open', sampled: false, openChallenge: OPEN, treeStatus: 'dead' },
    'not_found',
  ],
  [
    'a sampled Flagged tree with an open challenge',
    { sessionStatus: 'open', sampled: true, openChallenge: OPEN, treeStatus: 'flagged' },
    'challenge_active',
  ],
  [
    'a sampled Flagged tree',
    { sessionStatus: 'open', sampled: true, openChallenge: null, treeStatus: 'flagged' },
    'tree_not_alive',
  ],
])('%s answers %s', (_case, facts, code) => {
  expect(challengeRefusal(facts)?.code).toBe(code);
});

it('a sampled Alive tree with no open challenge may be challenged; the refusals carry their details', () => {
  const sampled = {
    sessionStatus: 'open',
    sampled: true,
    openChallenge: null,
    treeStatus: 'alive',
  };

  expect(challengeRefusal(sampled)).toBeNull();
  expect(challengeRefusal({ ...sampled, openChallenge: OPEN })).toEqual({
    code: 'challenge_active',
    details: { challengeId: OPEN.id, expiresAt: OPEN.expiresAt },
  });
  expect(challengeRefusal({ ...sampled, treeStatus: 'flagged' })).toEqual({
    code: 'tree_not_alive',
    details: { status: 'flagged' },
  });
});
