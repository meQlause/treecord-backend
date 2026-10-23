import { createApp } from './app.js';
import { readConfig } from './config.js';
import { privyJwks, privyVerifier } from './shared/auth/privy.js';
import { createChainClient } from './shared/chain/client.js';
import { createDatabase, pingDatabase } from './shared/db/database.js';
import { createLogger } from './shared/http/logger.js';
import { shutdownGracefully } from './shutdown.js';

// NFR-008: a missing or malformed variable stops the process here, before anything listens.
const config = readConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase({
  url: config.DATABASE_URL,
  poolMax: config.DATABASE_POOL_MAX,
  timeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  onConnectionError: (error) => logger.warn({ err: error }, 'postgres connection dropped'),
});
const chain = createChainClient(config.RPC_URL, config.RPC_TIMEOUT_MS);

const server = createApp({
  readiness: { database: () => pingDatabase(database), chain: () => chain.getBlockNumber() },
  logger,
  jsonBodyLimitKb: config.JSON_BODY_LIMIT_KB,
  auth: {
    verify: privyVerifier({
      appId: config.PRIVY_APP_ID,
      resolveKey: privyJwks(config.PRIVY_APP_ID),
    }),
    demoWalletAuth: config.DEMO_WALLET_AUTH,
  },
}).listen(config.PORT);

const stop = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'shutting down');
  void shutdownGracefully(server, {
    graceMs: config.SHUTDOWN_GRACE_MS,
    closeResources: () => database.destroy(),
  }).then(() => process.exit(0));
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
