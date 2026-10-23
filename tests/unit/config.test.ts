import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

// A complete local environment (docs/BE/be-stack.md §5, ADR-018: anvil, PostgreSQL, MinIO).
const VALID = {
  PORT: '4000',
  DATABASE_URL: 'postgres://treecord:treecord@127.0.0.1:5432/treecord',
  DATABASE_POOL_MAX: '10',
  CHAIN_ID: '31337',
  RPC_URL: 'http://127.0.0.1:8545',
  PRIVY_APP_ID: 'cm2treecordlocal0000000000',
  PRIVY_APP_SECRET: 'privy-local-secret',
  ATTESTER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'treecord',
  S3_SECRET_KEY: 'treecord-secret',
  WEB_ORIGIN: 'http://127.0.0.1:5173',
};
const REQUIRED = Object.keys(VALID);

const without = (name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== name));

describe('config — NFR-008: refuse to start with a missing or malformed variable', () => {
  it('accepts a complete environment', () => {
    expect(loadConfig(VALID)).toMatchObject({ PORT: 4000, CHAIN_ID: 31337, DATABASE_POOL_MAX: 10 });
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
    expect(() => loadConfig({ ...VALID, [name]: value })).toThrow(name);
  });

  it('keeps the demo wallet sign-in off and logs at info unless set (ADR-007)', () => {
    expect(loadConfig(VALID)).toMatchObject({ DEMO_WALLET_AUTH: false, LOG_LEVEL: 'info' });
  });

  it('takes the D-6 resource limits as configuration, defaulting to the planned values', () => {
    expect(loadConfig(VALID)).toMatchObject({
      JSON_BODY_LIMIT_KB: 64,
      DATABASE_STATEMENT_TIMEOUT_MS: 5000,
      RPC_TIMEOUT_MS: 10_000,
      S3_TIMEOUT_MS: 15_000,
      SHUTDOWN_GRACE_MS: 10_000,
    });
    expect(
      loadConfig({ ...VALID, DATABASE_STATEMENT_TIMEOUT_MS: '2500' }).DATABASE_STATEMENT_TIMEOUT_MS,
    ).toBe(2500);
  });

  it('reads DEMO_WALLET_AUTH=true as on', () => {
    expect(loadConfig({ ...VALID, DEMO_WALLET_AUTH: 'true' }).DEMO_WALLET_AUTH).toBe(true);
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
