import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chainClock } from '../../src/shared/chain/clock.js';
import { startAnvil, type TestChain } from '../helpers/anvil.js';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { rootsThatStay } from '../fixtures/roots-that-stay.js';

// REG-009 (docs/BE/testing.md §4): a milestone window judged by the server clock. Tree 3001's month-6 window is
// [2026-10-15T05:00Z, 2026-11-14T05:00Z). The API reads time from a real anvil; its server clock is set to the
// opposite side of the window each time, so only chain time can give the right answer.
const INSIDE = new Date('2026-10-23T03:12:44Z');
const PAST = new Date('2026-11-20T00:00:00Z');

let test: TestDatabase;
let chain: TestChain;

const monthSix = async (api: TestApi): Promise<string> => {
  const response = await request(api.app).get('/api/v1/trees/3001');

  expect(response.status).toBe(200);

  return response.body.milestones[2].status;
};

beforeAll(async () => {
  [test, chain] = await Promise.all([
    startMigratedDatabase(),
    startAnvil(new Date('2026-10-01T00:00:00Z')),
  ]);
  await rootsThatStay(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await Promise.all([test.stop(), chain.stop()]);
});

it('chain time inside the window, server clock past it: the window is open', async () => {
  await chain.mineAt(INSIDE);

  const api = testApi(test.database, await fakePrivy(), {
    chainNow: chainClock(chain.client),
    clock: () => PAST,
  });

  expect(await monthSix(api)).toBe('open');
});

it('chain time past the window, server clock inside it: the window is missed', async () => {
  await chain.mineAt(PAST);

  const api = testApi(test.database, await fakePrivy(), {
    chainNow: chainClock(chain.client),
    clock: () => INSIDE,
  });

  expect(await monthSix(api)).toBe('missed');
});
