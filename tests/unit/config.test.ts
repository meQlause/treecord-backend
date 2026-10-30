import { describe, expect, it } from 'vitest';
import { loadConfig, loadWorkerConfig } from '../../src/config.js';
import { VALID_ENV } from '../fixtures/env.js';

const REQUIRED = Object.keys(VALID_ENV);

const without = (name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(VALID_ENV).filter(([key]) => key !== name));

describe('config — NFR-008: refuse to start with a missing or malformed variable', () => {
  it('accepts a complete environment', () => {
    expect(loadConfig(VALID_ENV)).toMatchObject({
      PORT: 4000,
      CHAIN_ID: 31337,
      DATABASE_POOL_MAX: 10,
    });
  });

  it.each(REQUIRED)('fails naming %s when it is missing', (name) => {
    expect(() => loadConfig(without(name))).toThrow(name);
  });

  it.each([
    ['PORT', 'http'],
    ['DATABASE_URL', 'not a url'],
    ['DATABASE_POOL_MAX', '0'],
    ['CHAIN_ID', 'anvil'],
    ['RPC_URL', '127.0.0.1:8545'],
    ['ATTESTER_PRIVATE_KEY', '0x1234'],
    ['S3_PUBLIC_ENDPOINT', 'minio'],
    ['WEB_ORIGIN', '*'],
    ['DEMO_WALLET_AUTH', 'yes'],
    ['LOG_LEVEL', 'loud'],
    ['JSON_BODY_LIMIT_KB', '0'],
    ['DATABASE_STATEMENT_TIMEOUT_MS', '5s'],
    ['RPC_TIMEOUT_MS', '-1'],
    ['S3_TIMEOUT_MS', 'fast'],
    ['SHUTDOWN_GRACE_MS', '1.5'],
  ])('fails naming %s when it is malformed', (name, value) => {
    expect(() => loadConfig({ ...VALID_ENV, [name]: value })).toThrow(name);
  });

  it('keeps the demo wallet sign-in off and logs at info unless set (ADR-007)', () => {
    expect(loadConfig(VALID_ENV)).toMatchObject({ DEMO_WALLET_AUTH: false, LOG_LEVEL: 'info' });
  });

  it('takes the D-6 resource limits as configuration, defaulting to the planned values', () => {
    expect(loadConfig(VALID_ENV)).toMatchObject({
      JSON_BODY_LIMIT_KB: 64,
      DATABASE_STATEMENT_TIMEOUT_MS: 5000,
      RPC_TIMEOUT_MS: 10_000,
      S3_TIMEOUT_MS: 15_000,
      SHUTDOWN_GRACE_MS: 10_000,
    });
    expect(
      loadConfig({ ...VALID_ENV, DATABASE_STATEMENT_TIMEOUT_MS: '2500' })
        .DATABASE_STATEMENT_TIMEOUT_MS,
    ).toBe(2500);
  });

  it('reads DEMO_WALLET_AUTH=true as on', () => {
    expect(loadConfig({ ...VALID_ENV, DEMO_WALLET_AUTH: 'true' }).DEMO_WALLET_AUTH).toBe(true);
  });

  it('names every problem at once, not only the first', () => {
    const message = (() => {
      try {
        loadConfig({});
      } catch (error) {
        return (error as Error).message;
      }

      return '';
    })();

    for (const name of REQUIRED) {
      expect(message).toContain(name);
    }
  });
});

describe('config — ADR-014: the API holds no key that sends transactions', () => {
  it('never takes the operator or relayer key, even when the environment sets them (ADR-014)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      OPERATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
      RELAYER_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
    });

    expect(Object.keys(config)).not.toContain('OPERATOR_PRIVATE_KEY');
    expect(Object.keys(config)).not.toContain('RELAYER_PRIVATE_KEY');
  });
});

describe('worker config — FR-243: the Chainlink keeper address is optional', () => {
  // anvil's well-known dev keys (accounts 1 to 3), never used on a real network
  const WORKER_ENV = {
    RPC_URL: VALID_ENV.RPC_URL,
    CHAIN_ID: VALID_ENV.CHAIN_ID,
    DATABASE_URL: VALID_ENV.DATABASE_URL,
    OPERATOR_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ATTESTER_PRIVATE_KEY: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    RELAYER_PRIVATE_KEY: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    S3_ENDPOINT: VALID_ENV.S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT: VALID_ENV.S3_PUBLIC_ENDPOINT,
    S3_REGION: VALID_ENV.S3_REGION,
    S3_ACCESS_KEY: VALID_ENV.S3_ACCESS_KEY,
    S3_SECRET_KEY: VALID_ENV.S3_SECRET_KEY,
  };
  const KEEPER = '0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1';

  it('starts without a keeper: the offline setup is unchanged (D-1)', () => {
    expect(loadWorkerConfig(WORKER_ENV).CHAINLINK_KEEPER_ADDRESS).toBeUndefined();
  });

  it('takes a keeper address', () => {
    expect(
      loadWorkerConfig({ ...WORKER_ENV, CHAINLINK_KEEPER_ADDRESS: KEEPER })
        .CHAINLINK_KEEPER_ADDRESS,
    ).toBe(KEEPER);
  });

  it('refuses a malformed keeper address, naming the variable', () => {
    expect(() => loadWorkerConfig({ ...WORKER_ENV, CHAINLINK_KEEPER_ADDRESS: '0x123' })).toThrow(
      'CHAINLINK_KEEPER_ADDRESS',
    );
  });
});
