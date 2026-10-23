import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import {
  EMPTY_CAMPAIGN,
  EVENTS,
  impactReport,
  MANGROVES,
  ROOTS,
} from '../../../fixtures/impact-report.js';

// "As of 21 Oct 2026, 05:00 UTC": the server clock when the read starts (reports §1).
const AS_OF = new Date('2026-10-21T05:00:00.000Z');

let test: TestDatabase;
let api: TestApi;

const get = (path: string) => request(api.app).get(`/api/v1/reports/campaign/${path}`);

const ITEMS = EVENTS.map((event) => ({
  treeId: String(event.treeId),
  kind: event.kind,
  milestone: event.milestone,
  month: [0, 3, 6][event.milestone],
  at: event.at,
  evidenceHash: event.evidenceHash,
  blockNumber: String(event.block),
  txHash: event.txHash,
}));

// reports.md §1's response for "Roots that stay".
const ROOTS_REPORT = {
  generatedAt: '2026-10-21T05:00:00.000Z',
  campaign: {
    address: ROOTS,
    status: 'active',
    title: 'Roots that stay',
    species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
    region: { name: 'Banyumas, Central Java', radiusM: 2500 },
    treeTarget: 1200,
    commitmentUnits: 36,
  },
  trees: {
    planted: 984,
    alive: 948,
    flagged: 2,
    dead: 20,
    removed: 14,
    completed: 0,
    survivalRateBps: 9654,
    averageAgeDays: 186,
  },
  funding: {
    fundingTarget: '18000000000',
    fundedAmount: '18000000000',
    progressBps: 10000,
    contributors: 120,
    refundedAmount: '0',
  },
  incentives: {
    incentivePool: '12600000000',
    paidAmount: '2100000000',
    paidBps: 1666,
    forfeitedAmount: '68000000',
    byMilestone: [
      { milestone: 0, month: 0, payouts: 984, amount: '1033200000' },
      { milestone: 1, month: 3, payouts: 984, amount: '1033200000' },
      { milestone: 2, month: 6, payouts: 32, amount: '33600000' },
      { milestone: 3, month: 12, payouts: 0, amount: '0' },
      { milestone: 4, month: 24, payouts: 0, amount: '0' },
      { milestone: 5, month: 36, payouts: 0, amount: '0' },
    ],
  },
  carbon: {
    estimate: { label: 'pre-certification', estimatedAmount: '8005', method: null },
    issued: { label: 'issued', issuedAmount: '0', retiredAmount: '0', batches: [] },
  },
  evidence: { items: ITEMS, nextCursor: null, total: 3 },
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy(), { clock: () => AS_OF });
  await impactReport(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/reports.md §1, FR-064–FR-069.
describe('GET /api/v1/reports/campaign/:address', () => {
  it('answers the §1 example for "Roots that stay"', async () => {
    const response = await get(ROOTS);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ report: ROOTS_REPORT });
  });

  it('answers the §1 carbon block for "Back to the mangroves": batches newest first', async () => {
    expect((await get(MANGROVES)).body.report.carbon).toEqual({
      estimate: { label: 'pre-certification', estimatedAmount: '20000', method: null },
      issued: {
        label: 'issued',
        issuedAmount: '22000',
        retiredAmount: '400',
        batches: [
          {
            batchId: '101',
            registry: 'SRN PPI',
            vintage: 2025,
            serialStart: 'SRN-2025-00001',
            serialEnd: 'SRN-2025-16000',
            issuedAmount: '16000',
            issuedTxHash: '0xf1295876f501f93023aaf30204d5604394b4c7b7dd59fc4e451dafcd3dfe67a0',
          },
          {
            batchId: '103',
            registry: 'SRN PPI',
            vintage: 2024,
            serialStart: 'SRN-2024-00001',
            serialEnd: 'SRN-2024-06000',
            issuedAmount: '6000',
            issuedTxHash: '0x3ba98bd5818a98e741d44cf260e44db09cf49f483df10f737982a67a0abeb208',
          },
        ],
      },
    });
  });

  it('a campaign with nothing planted has no rates yet, never zeros (FR-065, FR-067)', async () => {
    const { report } = (await get(EMPTY_CAMPAIGN)).body;

    expect(report.trees).toMatchObject({ planted: 0, survivalRateBps: null, averageAgeDays: null });
    expect(report.incentives).toMatchObject({ incentivePool: null, paidBps: null });
    expect(report.carbon.estimate.estimatedAmount).toBeNull();
    expect(report.evidence).toEqual({ items: [], nextCursor: null, total: 0 });
  });
});

// docs/BE/features/reports.md §2, FR-069.
describe('GET /api/v1/reports/campaign/:address/evidence', () => {
  it('continues after the §2 cursor (block 24118402, log 3)', async () => {
    const response = await get(`${ROOTS}/evidence?cursor=eyJiIjoiMjQxMTg0MDIiLCJsIjozfQ&limit=20`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: ITEMS.slice(1), nextCursor: null, total: 3 });
  });

  it('pages one at a time without skipping or repeating a row', async () => {
    const first = await get(`${ROOTS}/evidence?limit=1`);
    const second = await get(`${ROOTS}/evidence?limit=1&cursor=${first.body.nextCursor}`);
    const third = await get(`${ROOTS}/evidence?limit=1&cursor=${second.body.nextCursor}`);

    expect([first, second, third].map((page) => page.body.items[0].treeId)).toEqual([
      '3001',
      '3002',
      '3003',
    ]);
    expect(third.body.nextCursor).toBeNull();
  });
});

describe('the report refuses', () => {
  it.each([
    ['a malformed address', '0x12', 400, 'invalid_path'],
    ['an unknown campaign', `0x${'9'.repeat(40)}`, 404, 'not_found'],
    ['an unknown campaign, evidence', `0x${'9'.repeat(40)}/evidence`, 404, 'not_found'],
    ['a cursor it did not write', `${ROOTS}/evidence?cursor=nope`, 400, 'invalid_cursor'],
    ['a limit of 0', `${ROOTS}/evidence?limit=0`, 400, 'validation_error'],
    ['an unknown parameter', `${ROOTS}/evidence?sort=asc`, 400, 'validation_error'],
  ])('%s', async (_case, path, status, code) => {
    const response = await get(path);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});
