import { createServer, type Server } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChainClient } from '../../../../src/shared/chain/client.js';
import { chainClock } from '../../../../src/shared/chain/clock.js';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import { ROOTS, rootsThatStay } from '../../../fixtures/roots-that-stay.js';

// ADR-010: chain reads have a timeout and no retry inside a request. A dead RPC makes the chain-timed page answer 503
// within that timeout, while pages that only read the mirror still answer.
const RPC_TIMEOUT_MS = 400;
// what a timeout of 400 ms may cost once the request, the database reads and a busy machine are added
const SLACK_MS = 600;

let test: TestDatabase;
// accepts connections and never answers: an RPC that hangs
let hung: Server;
let hungUrl: string;

const apiOn = async (rpcUrl: string): Promise<TestApi> =>
  testApi(test.database, await fakePrivy(), {
    chainNow: chainClock(createChainClient(rpcUrl, RPC_TIMEOUT_MS)),
  });

beforeAll(async () => {
  test = await startMigratedDatabase();
  await rootsThatStay(test.database);
  hung = createServer(() => undefined);
  await new Promise<void>((resolve) => {
    hung.listen(0, '127.0.0.1', resolve);
  });
  hungUrl = `http://127.0.0.1:${(hung.address() as { port: number }).port}`;
}, CONTAINER_START_MS);

afterAll(async () => {
  hung.close();
  await test.stop();
});

describe('a failed chain read (ADR-010)', () => {
  it('an RPC that hangs: the tree page answers 503 within the RPC timeout, not after retries', async () => {
    const api = await apiOn(hungUrl);
    const started = performance.now();
    const response = await request(api.app).get('/api/v1/trees/3001');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_unavailable');
    expect(performance.now() - started).toBeLessThan(RPC_TIMEOUT_MS + SLACK_MS);
  });

  it('an RPC that refuses connections: 503 as well', async () => {
    const api = await apiOn('http://127.0.0.1:9');
    const response = await request(api.app).get('/api/v1/trees/3001');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_unavailable');
  });

  it.each([
    ['the catalog', '/api/v1/campaigns'],
    ['a campaign page', `/api/v1/campaigns/${ROOTS}`],
    ['the impact report', `/api/v1/reports/campaign/${ROOTS}`],
  ])('%s still answers from the mirror', async (_page, path) => {
    const api = await apiOn(hungUrl);

    expect((await request(api.app).get(path)).status).toBe(200);
  });
});
