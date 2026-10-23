// A complete local environment (docs/BE/be-stack.md §5, ADR-018: anvil, PostgreSQL, MinIO).
export const VALID_ENV = {
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
  PUBLIC_API_URL: 'http://localhost:3001',
};
